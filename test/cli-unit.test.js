/**
 * Le CLI éprouvé sans lancer de processus : `run()` reçoit son horloge, son
 * `$HOME`, sa sortie et son système de fichiers. C'est ce qui permet de tester
 * ce que le temps produit — l'expiration d'une session — sans attendre, et
 * sans falsifier un fichier de session pour simuler ce que l'horloge dirait.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import { run, EXIT } from '../lib/cli.js';
import { generateTopic, generateKey, deriveWriteKey } from '../lib/crypto.js';
import { encodeMessage, decodeMessage } from '../lib/protocol.js';
import { publish } from '../lib/ntfy.js';
import { buildSessionUrl } from '../lib/url.js';
import { decodeB64u, encodeB64u } from '../lib/bytes.js';

const UI = 'https://exemple.test/chat/';
const HEURE = 3600_000;

let bus;
let home;
let horloge;

before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agentchat-u-')); horloge = 1_780_000_000_000; });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Lance une commande et rend { code, out[], err[] }. */
async function lancer(argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    home,
    now: () => horloge,
    sleep: async () => {},
    uiBase: UI,
    ...extra,
  });
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
}

const creer = async (argv = []) => (await lancer(['create', '--server', bus.base, ...argv])).out[0];
const topicDe = (url) => new URLSearchParams(url.slice(url.indexOf('#') + 1)).get('t');
const sessionDe = (topic) => JSON.parse(readFileSync(join(home, '.agentchat', `${topic}.json`), 'utf8'));

const cleDe = (url) => decodeB64u(new URLSearchParams(url.slice(url.indexOf('#') + 1)).get('k'));

/** Tous les `control:roster` publiés sur un topic, déchiffrés, dans l'ordre. */
async function rostersDe(url) {
  const topic = topicDe(url);
  const key = cleDe(url);
  const kw = await deriveWriteKey(key);
  const lus = [];
  for (const raw of bus.messages(topic)) {
    try {
      const m = await decodeMessage({ key, kw, topic, raw });
      if (m?.kind === 'control' && m.meta?.type === 'roster') lus.push(m);
    } catch { /* pas un roster lisible */ }
  }
  return lus;
}

/** Publie un roster comme le ferait un pair, avec le contenu qu'on veut. */
async function publierRosterBrut(url, meta, from = 'pair') {
  const topic = topicDe(url);
  const key = cleDe(url);
  const env = await encodeMessage({
    key, kw: await deriveWriteKey(key), topic, from, kind: 'control', text: 'roster', meta,
  });
  return publish({ base: bus.base, topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig });
}

describe('cli — une durée de vie ne s\'invente pas (D-09, R4)', () => {
  test('rejoindre un salon dont aucun roster n\'est lisible n\'annonce aucune durée de vie', async () => {
    // ntfy accuse réception avant de servir depuis son cache : un `join` juste
    // après un `create` ne trouve parfois rien. Le rejoignant retombait alors
    // sur 24 h et sur l'instant présent — **et publiait ce roster**. Une
    // session créée pour 2 h devenait une session de 24 h pour tout le monde.
    const topic = generateTopic();
    const key = generateKey();
    const url = buildSessionUrl({ topic, key, server: bus.base, uiBase: UI });

    const r = await lancer(['join', url, '--as', 'B']);
    assert.equal(r.code, EXIT.OK);

    const [roster] = await rostersDe(url);
    assert.ok(roster, 'le rejoignant doit tout de même annoncer sa présence');
    assert.deepEqual(roster.meta.participants, ['B']);
    assert.equal(Object.hasOwn(roster.meta, 'ttlH'), false, `durée de vie annoncée à tort : ${JSON.stringify(roster.meta)}`);
    assert.equal(Object.hasOwn(roster.meta, 'createdAt'), false);
    assert.match(r.stderr, /durée de vie/i);
  });

  test('rejoindre un salon dont le roster est lisible reprend sa durée de vie, sans la déplacer', async () => {
    const url = await creer(['--ttl', '2', '--as', 'A']);
    const avant = (await rostersDe(url))[0].meta;

    horloge += 30 * 60_000;
    await lancer(['join', url, '--as', 'B']);

    const rosterDeB = (await rostersDe(url)).at(-1);
    assert.equal(rosterDeB.meta.ttlH, 2, 'un arrivant ne redéfinit pas la durée du salon');
    assert.equal(rosterDeB.meta.createdAt, avant.createdAt, 'ni sa date de départ');
  });

  test('une durée de vie annoncée plus tôt n\'est pas effacée par un roster muet', async () => {
    const url = await creer(['--ttl', '2', '--as', 'A']);
    const creation = (await rostersDe(url))[0].meta.createdAt;
    // Un pair qui ne connaissait pas la durée de vie s'est annoncé sans elle.
    await publierRosterBrut(url, { type: 'roster', participants: ['B'] }, 'B');

    // C arrive d'ailleurs : aucun fichier de session local ne peut le renseigner,
    // le bus est sa seule source.
    const ailleurs = mkdtempSync(join(tmpdir(), 'agentchat-c-'));
    try {
      const r = await lancer(['join', url, '--as', 'C'], { home: ailleurs });
      const sortie = JSON.parse(r.out[0]);
      assert.equal(sortie.ttlH, 2, 'la durée de vie doit être reprise du roster qui la porte');
      assert.equal(sortie.expiresAt, creation + 2 * HEURE);
    } finally {
      rmSync(ailleurs, { recursive: true, force: true });
    }
  });

  test('faute de durée de vie connue, le rejoignant peut tout de même écrire', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const url = buildSessionUrl({ topic, key, server: bus.base, uiBase: UI });
    await lancer(['join', url, '--as', 'B']);

    // Ne rien savoir de la durée de vie n'est pas la même chose que la savoir
    // dépassée : refuser d'écrire ici rendrait le CLI inutilisable dès que le
    // cache du bus a tourné.
    const r = await lancer(['send', url, 'bonjour']);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(JSON.parse(r.out[0]).sent, true);
  });
});

describe('cli — le temps qui passe (AC-10, R4)', () => {
  test('rejoindre après le TTL se fait en lecture, sans annonce publiée', async () => {
    const url = await creer(['--ttl', '1']);
    const avant = bus.publishCount;

    horloge += 2 * HEURE;
    const r = await lancer(['join', url, '--as', 'B']);

    assert.equal(r.code, EXIT.OK);
    assert.equal(JSON.parse(r.out[0]).expired, true);
    assert.equal(bus.publishCount, avant, 'une session expirée ne publie plus de roster');
    assert.match(r.stderr, /expirée/);
  });

  test('rejoindre avant le TTL publie bien le roster', async () => {
    const url = await creer(['--ttl', '2']);
    const avant = bus.publishCount;

    horloge += 1 * HEURE;
    const r = await lancer(['join', url, '--as', 'B']);

    assert.equal(JSON.parse(r.out[0]).expired, false);
    assert.equal(bus.publishCount, avant + 1);
  });

  test('la durée de vie annoncée par le roster prime sur ce que croit le disque', async () => {
    const url = await creer(['--ttl', '3']);
    const topic = topicDe(url);
    // Un participant dont le fichier local prétend autre chose : c'est le bus
    // qui fait foi, puisque le roster porte le TTL (R4).
    const s = sessionDe(topic);
    writeFileSync(join(home, '.agentchat', `${topic}.json`), JSON.stringify({ ...s, ttlH: 99 }));

    const r = await lancer(['join', url, '--as', 'B']);
    assert.equal(JSON.parse(r.out[0]).ttlH, 3);
  });

  test('écrire après le TTL est refusé avec le code 3, et rien n\'est publié', async () => {
    const url = await creer(['--ttl', '1']);
    await lancer(['join', url, '--as', 'A']);
    const avant = bus.publishCount;

    horloge += 90 * 60_000;
    const r = await lancer(['send', url, 'trop tard', '--as', 'A']);

    assert.equal(r.code, EXIT.READONLY);
    assert.match(r.stderr, /expirée/);
    assert.equal(bus.publishCount, avant);
  });

  test('lire et exporter restent possibles après le TTL', async () => {
    const url = await creer(['--ttl', '1']);
    await lancer(['join', url, '--as', 'A']);
    await lancer(['send', url, 'pendant', '--as', 'A']);

    horloge += 5 * HEURE;
    const lu = await lancer(['tail', url, '--once']);
    assert.equal(lu.code, EXIT.OK);
    assert.ok(lu.out.map(JSON.parse).some((m) => m.text === 'pendant'));

    const exporte = await lancer(['export', url]);
    assert.equal(exporte.code, EXIT.OK);
    assert.ok(JSON.parse(exporte.stdout).messages.length >= 2);
  });

  test('migrer après le TTL est refusé lui aussi', async () => {
    const url = await creer(['--ttl', '1']);
    await lancer(['join', url, '--as', 'A']);
    horloge += 2 * HEURE;
    assert.equal((await lancer(['migrate', url, '--as', 'A'])).code, EXIT.READONLY);
  });
});

describe('cli — cadence des envois (R5)', () => {
  test('deux envois rapprochés sont espacés d\'au moins 200 ms', async () => {
    const url = await creer();
    await lancer(['join', url, '--as', 'A']);

    const attentes = [];
    const io = { sleep: async (ms) => attentes.push(ms) };
    await lancer(['send', url, 'un', '--as', 'A'], io);
    await lancer(['send', url, 'deux', '--as', 'A'], io);

    assert.ok(attentes.some((ms) => ms > 0 && ms <= 200), `attentes observées : ${attentes}`);
  });

  test('un envoi bien après le précédent n\'attend pas', async () => {
    const url = await creer();
    await lancer(['join', url, '--as', 'A']);
    const attentes = [];
    await lancer(['send', url, 'un', '--as', 'A'], { sleep: async (ms) => attentes.push(ms) });
    horloge += 5000;
    await lancer(['send', url, 'deux', '--as', 'A'], { sleep: async (ms) => attentes.push(ms) });
    assert.deepEqual(attentes, []);
  });
});

describe('cli — usage et codes de retour', () => {
  test('sans argument : mode d\'emploi et code 2', async () => {
    const r = await lancer([]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stdout, /agentchat/);
  });

  test('« help » et « --help » sortent en 0', async () => {
    for (const argv of [['help'], ['--help'], ['-h'], ['tail', '--help']]) {
      assert.equal((await lancer(argv)).code, EXIT.OK, argv.join(' '));
    }
  });

  test('commande inconnue : code 2, et le mode d\'emploi est rappelé', async () => {
    const r = await lancer(['danser']);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /danser/);
  });

  test('option inconnue : code 2', async () => {
    assert.equal((await lancer(['create', '--turbo'])).code, EXIT.USAGE);
  });

  test('une URL est exigée là où il en faut une', async () => {
    for (const argv of [['join'], ['tail'], ['send'], ['export'], ['migrate'], ['replay']]) {
      assert.equal((await lancer(argv)).code, EXIT.USAGE, argv.join(' '));
    }
  });

  test('join sans --as est refusé', async () => {
    assert.equal((await lancer(['join', await creer()])).code, EXIT.USAGE);
  });

  test('send sans texte, et send avec un kind inconnu', async () => {
    const url = await creer();
    assert.equal((await lancer(['send', url])).code, EXIT.USAGE);
    assert.equal((await lancer(['send', url, 'x', '--as', 'A', '--kind', 'chanson'])).code, EXIT.USAGE);
  });

  test('send sans --as ni session connue : refusé plutôt que signé d\'un nom inventé', async () => {
    const url = await creer();
    const vierge = mkdtempSync(join(tmpdir(), 'agentchat-v-'));
    try {
      assert.equal((await lancer(['send', url, 'x'], { home: vierge })).code, EXIT.USAGE);
    } finally {
      rmSync(vierge, { recursive: true, force: true });
    }
  });

  test('--ui choisit la base de l\'URL imprimée, sans passer par l\'environnement', async () => {
    // Documenté dans le mode d'emploi et accepté par l'analyseur d'arguments :
    // l'ignorer rendait la recette locale impossible autrement qu'en posant
    // AGENTCHAT_UI_BASE, ce que le mode d'emploi ne dit nulle part.
    const url = await creer(['--ui', 'http://127.0.0.1:8123']);
    assert.ok(url.startsWith('http://127.0.0.1:8123/#t='), `base non appliquée : ${url}`);
  });

  test('--ui vaut aussi pour l\'URL du nouveau topic après une migration', async () => {
    const url = await creer(['--as', 'A']);
    const r = await lancer(['migrate', url, '--as', 'A', '--ui', 'http://127.0.0.1:8123']);
    assert.equal(r.code, EXIT.OK);
    assert.ok(r.out[0].startsWith('http://127.0.0.1:8123/#t='), `base non appliquée : ${r.out[0]}`);
  });

  test('sans --ui, la base reste celle de l\'environnement', async () => {
    assert.ok((await creer()).startsWith(UI), 'la base par défaut ne doit pas bouger');
  });

  test('une URL sans fragment est refusée : la clé n\'y est pas', async () => {
    const r = await lancer(['tail', 'https://exemple.test/chat/']);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /fragment/);
  });
});

describe('cli — panne du bus', () => {
  test('un serveur injoignable donne le code 4, jamais un faux succès', async () => {
    const url = (await lancer(['create', '--server', 'http://127.0.0.1:9'])).out[0];
    assert.equal(url, undefined, 'aucune URL ne doit être imprimée si le roster n\'est pas parti');

    const bonne = await creer();
    const casse = bonne.replace(/&s=[^&]*/, '') + `&s=${Buffer.from('http://127.0.0.1:9').toString('base64url')}`;
    const r = await lancer(['send', casse, 'x', '--as', 'A'], { sleep: async () => {} });
    assert.equal(r.code, EXIT.NETWORK);
    assert.equal(r.stdout.includes('sent'), false);
  });

  test('un corps trop gros est refusé avant de partir (R5)', async () => {
    const url = await creer();
    await lancer(['join', url, '--as', 'A']);
    const avant = bus.publishCount;
    const r = await lancer(['send', url, 'x'.repeat(70 * 1024), '--as', 'A']);
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(bus.publishCount, avant);
  });
});

describe('cli — relecture d\'archive', () => {
  test('replay lit le fichier par la fonction injectée, donc sans toucher au disque réel', async () => {
    const url = await creer();
    await lancer(['join', url, '--as', 'A']);
    await lancer(['send', url, 'archivé', '--as', 'A']);
    const archive = (await lancer(['export', url])).stdout;

    const r = await lancer(['replay', 'en-memoire.json'], { readFile: () => archive });
    assert.equal(r.code, EXIT.OK);
    assert.ok(r.out.map(JSON.parse).some((m) => m.text === 'archivé'));
  });

  test('un fichier illisible est refusé pour ce qu\'il est', async () => {
    const r = await lancer(['replay', 'x.json'], { readFile: () => 'ceci n\'est pas du JSON' });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /illisible/);
  });

  test('un export d\'une autre session ne se relit pas avec la mauvaise URL', async () => {
    const a = await creer();
    await lancer(['join', a, '--as', 'A']);
    const archive = (await lancer(['export', a])).stdout;
    const b = await creer();
    const r = await lancer(['replay', 'x.json', '--url', b], { readFile: () => archive });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /topic/);
  });
});
