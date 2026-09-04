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
