/**
 * Critères d'acceptation de la spec, un test par critère, éprouvés de bout en
 * bout : vrais processus `agentchat`, vrai HTTP, serveur ntfy local.
 *
 * Lot 1 : AC-01, AC-02, AC-03, AC-04, AC-05, AC-07, AC-08, AC-11.
 * Lot 2 : AC-09, AC-10, AC-15, AC-16 (AC-06 et AC-13 sont éprouvés par test/interface.test.js).
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import { TAG_SIG } from '../lib/protocol.js';
import { altererCorps } from './helpers/alterer.js';

const execFileP = promisify(execFile);
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(RACINE, 'bin', 'agentchat.js');
const UI = 'https://exemple.test/chat/';

let bus;
let home;

before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agentchat-ac-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = (extra = {}) => ({ ...process.env, HOME: home, AGENTCHAT_UI_BASE: UI, ...extra });

/**
 * Lance le CLI et rend { code, stdout, stderr } sans jamais lever.
 * Le delai de garde doit rester plus large que le repli du client (AC-11 :
 * 1+2+4+8 s), sans quoi c'est le test qui tue le processus et le code de
 * retour observe n'est plus celui du CLI.
 */
async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
      env: env(opts.env), timeout: opts.timeout ?? 15000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (e.killed) throw new Error(`le CLI a depasse le delai de garde du test : agentchat ${args.join(' ')}`);
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const lignes = (s) => s.split('\n').filter((l) => l.trim().length > 0);
const creer = async (extra = []) => (await cli(['create', '--server', bus.base, ...extra])).stdout.trim();
const topicDe = (url) => new URLSearchParams(url.slice(url.indexOf('#') + 1)).get('t');

describe('AC-01 — création de session', () => {
  test("l'URL imprimée a exactement la forme attendue", async () => {
    const r = await cli(['create', '--ttl', '2', '--server', bus.base]);
    assert.equal(r.code, 0, r.stderr);
    const url = r.stdout.trim();
    assert.match(url, /^https:\/\/exemple\.test\/chat\/#t=ac-[A-Za-z0-9_-]{32}&k=[A-Za-z0-9_-]{43}(&s=[A-Za-z0-9_-]+)?$/);
  });

  test('le fichier de session est écrit en mode 600', async () => {
    const url = await creer(['--ttl', '2']);
    const chemin = join(home, '.agentchat', `${topicDe(url)}.json`);
    assert.equal(statSync(chemin).mode & 0o777, 0o600);
    const s = JSON.parse(readFileSync(chemin, 'utf8'));
    assert.equal(s.topic, topicDe(url));
    assert.equal(s.ttlH, 2);
  });

  test('un control:roster chiffré est publié sur ntfy', async () => {
    const url = await creer(['--ttl', '2']);
    const stockes = bus.messages(topicDe(url));
    assert.equal(stockes.length, 1);
    assert.ok(stockes[0].tags.includes('control'));
    assert.match(stockes[0].message, /^[A-Za-z0-9_-]+$/);
    assert.equal(stockes[0].message.includes('roster'), false, 'le mot « roster » ne doit pas être lisible');
  });

  test('le roster porte la durée de vie, lisible seulement par un porteur de la clé (R4)', async () => {
    const url = await creer(['--ttl', '2']);
    const r = await cli(['tail', url, '--once']);
    const m = JSON.parse(lignes(r.stdout)[0]);
    assert.equal(m.kind, 'control');
    assert.equal(m.meta.type, 'roster');
    assert.equal(m.meta.ttlH, 2);
    assert.equal(m.verified, true);
  });

  test('--ttl hors bornes est refusé (code 2) et rien n\'est publié', async () => {
    const avant = bus.publishCount;
    const r = await cli(['create', '--ttl', '999', '--server', bus.base]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /168/);
    assert.equal(bus.publishCount, avant);
  });
});

describe('AC-02 — deux CLI conversent en moins de 3 s', () => {
  test('B voit la ligne de A, vérifiée, sous 3 s', async () => {
    const url = await creer();
    assert.equal((await cli(['join', url, '--as', 'A'])).code, 0);

    const homeB = mkdtempSync(join(tmpdir(), 'agentchat-b-'));
    try {
      const envB = { ...process.env, HOME: homeB, AGENTCHAT_UI_BASE: UI };
      await execFileP(process.execPath, [CLI, 'join', url, '--as', 'B'], { env: envB });

      const tail = spawn(process.execPath, [CLI, 'tail', url, '--as', 'B', '--since', 'all'], { env: envB });
      const recus = [];
      let debut = 0;
      const attendu = new Promise((resolve, reject) => {
        let tampon = '';
        tail.stdout.on('data', (c) => {
          tampon += c.toString();
          const parts = tampon.split('\n');
          tampon = parts.pop();
          for (const l of parts.filter((x) => x.trim())) {
            const m = JSON.parse(l);
            recus.push(m);
            if (m.text === 'ping') resolve(Date.now() - debut);
          }
        });
        tail.on('error', reject);
      });

      await new Promise((r) => setTimeout(r, 400));
      debut = Date.now();
      const envoi = await cli(['send', url, 'ping', '--as', 'A']);
      assert.equal(envoi.code, 0, envoi.stderr);

      const latence = await Promise.race([
        attendu,
        new Promise((_, rej) => setTimeout(() => rej(new Error('rien reçu en 3 s')), 3000)),
      ]);
      tail.kill('SIGTERM');

      const ping = recus.find((m) => m.text === 'ping');
      assert.deepEqual(
        { from: ping.from, text: ping.text, verified: ping.verified },
        { from: 'A', text: 'ping', verified: true },
      );
      assert.ok(latence < 3000, `latence ${latence} ms`);
      assert.ok(Number.isSafeInteger(ping.ts) && typeof ping.id === 'string' && ping.kind === 'text');
    } finally {
      rmSync(homeB, { recursive: true, force: true });
    }
  });
});

describe('AC-03 — rien en clair sur le bus', () => {
  test('ni « ping » ni son base64 n\'apparaissent dans la réponse brute de ntfy', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'ping', '--as', 'A']);

    const brut = bus.rawDump(topicDe(url));
    assert.ok(brut.length > 0);
    assert.equal(brut.includes('ping'), false, 'le clair est visible');
    for (const enc of ['base64', 'base64url', 'hex']) {
      assert.equal(brut.includes(Buffer.from('ping').toString(enc)), false, `« ping » visible en ${enc}`);
    }
  });

  test("la clé de session n'apparaît nulle part sur le bus (R1)", async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'un secret bien gardé', '--as', 'A']);
    const k = new URLSearchParams(url.slice(url.indexOf('#') + 1)).get('k');
    assert.equal(bus.rawDump(topicDe(url)).includes(k), false);
  });

  test("un message plus long ne fuit pas davantage", async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    const phrase = 'rendez-vous demain matin devant la bibliotheque municipale';
    await cli(['send', url, phrase, '--as', 'A']);
    const brut = bus.rawDump(topicDe(url));

    assert.equal(brut.includes(phrase), false, 'la phrase entiere est visible');
    // Un corps chiffre est du base64url : une suite de 1 a 3 caracteres y
    // apparait par pur hasard. Seuls les mots assez longs pour que la
    // coincidence soit invraisemblable constituent une preuve de fuite.
    for (const mot of phrase.split(/[ -]/).filter((m) => m.length >= 4)) {
      assert.equal(brut.includes(mot), false, mot);
    }
  });
});

describe('AC-04 — signature altérée', () => {
  test('le message est rendu non vérifié, sans être présenté comme authentique', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'ping', '--as', 'A']);

    bus.tamper(topicDe(url), (m) => {
      m.tags = m.tags.map((t) => (t.startsWith(TAG_SIG) ? `${TAG_SIG}${'A'.repeat(43)}` : t));
    });

    const r = await cli(['tail', url, '--once', '--as', 'B']);
    assert.equal(r.code, 0);
    const m = lignes(r.stdout).map(JSON.parse).find((x) => x.text === 'ping');
    assert.equal(m.verified, false, 'un message altéré ne doit jamais être « verified: true »');
    assert.equal(m.text, 'ping');
  });

  test('une signature simplement absente donne le même verdict', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'pong', '--as', 'A']);
    bus.tamper(topicDe(url), (m) => { m.tags = m.tags.filter((t) => !t.startsWith(TAG_SIG)); });
    const m = lignes((await cli(['tail', url, '--once'])).stdout).map(JSON.parse).find((x) => x.text === 'pong');
    assert.equal(m.verified, false);
  });
});

describe('AC-05 — chiffré altéré', () => {
  test('rien de partiel n\'est affiché, le message est marqué « intégrité invalide », code 5', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'message confidentiel', '--as', 'A']);

    bus.tamper(topicDe(url), (m) => {
      const o = Buffer.from(m.message, 'base64url');
      o[o.length - 1] ^= 0x01;
      m.message = o.toString('base64url');
    });

    const r = await cli(['tail', url, '--once']);
    assert.equal(r.code, 5, 'lecture d\'un message altéré → code 5');

    const sorties = lignes(r.stdout).map(JSON.parse);
    const casse = sorties.find((m) => m.integrity === 'invalid');
    assert.ok(casse, 'le message altéré doit être signalé');
    assert.equal(casse.verified, false);
    assert.equal('text' in casse, false, 'aucun texte, même partiel');
    assert.equal('from' in casse, false, 'aucun auteur présumé');
    assert.equal(r.stdout.includes('confidentiel'), false);
    assert.equal(r.stderr.includes('confidentiel'), false, 'le journal ne doit jamais porter de clair');
  });

  test("un auteur réécrit sur le bus est détecté par l'AAD", async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'ping', '--as', 'A']);
    bus.tamper(topicDe(url), (m) => { m.title = 'mallory'; });
    const r = await cli(['tail', url, '--once']);
    assert.equal(r.code, 5);
    assert.equal(r.stdout.includes('ping'), false);
  });
});

describe('AC-07 — reprise sans doublon', () => {
  test('« --since <dernier id> » ne rend que la suite', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    for (const t of ['un', 'deux', 'trois']) await cli(['send', url, t, '--as', 'A']);

    const tout = lignes((await cli(['tail', url, '--once', '--since', 'all'])).stdout).map(JSON.parse);
    const textes = tout.filter((m) => m.kind === 'text').map((m) => m.text);
    assert.deepEqual(textes, ['un', 'deux', 'trois']);

    const ancre = tout.find((m) => m.text === 'un').id;
    const suite = lignes((await cli(['tail', url, '--once', '--since', ancre])).stdout).map(JSON.parse);
    assert.deepEqual(suite.map((m) => m.text), ['deux', 'trois']);
  });

  test('la reprise implicite repart du dernier identifiant mémorisé', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'avant', '--as', 'A']);
    await cli(['tail', url, '--once', '--since', 'all']);          // mémorise lastId

    await cli(['send', url, 'apres', '--as', 'A']);
    const reprise = lignes((await cli(['tail', url, '--once', '--since', 'last'])).stdout).map(JSON.parse);
    assert.deepEqual(reprise.map((m) => m.text), ['apres'], 'ni doublon ni perte');
  });

  test('un nonce déjà vu est écarté même si le bus le redonne', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'unique', '--as', 'A']);
    // Le bus rejoue le dernier message tel quel.
    const t = topicDe(url);
    bus.messages(t).push({ ...bus.messages(t)[bus.messages(t).length - 1], id: 'rejoue1' });

    const vus = lignes((await cli(['tail', url, '--once', '--since', 'all'])).stdout).map(JSON.parse);
    assert.equal(vus.filter((m) => m.text === 'unique').length, 1, 'le rejeu doit être écarté');
  });
});

describe('AC-08 — mode observateur', () => {
  test('send sur une URL ro=1 échoue avec le code 3 et ne publie rien', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    const urlRo = `${url}&ro=1`;

    const avant = bus.publishCount;
    const r = await cli(['send', urlRo, 'tentative', '--as', 'observateur']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /observateur|lecture seule|écriture refusée/i);
    assert.equal(bus.publishCount, avant, 'aucune publication');
  });

  test('une session rejointe en ro reste en lecture seule ensuite', async () => {
    const url = await creer();
    const urlRo = `${url}&ro=1`;
    assert.equal((await cli(['join', urlRo, '--as', 'observateur'])).code, 0);
    const avant = bus.publishCount;
    assert.equal((await cli(['send', url, 'tentative'])).code, 3, 'le fichier de session fait foi');
    assert.equal(bus.publishCount, avant);
  });

  test("l'observateur lit pourtant le flux déchiffré", async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'visible', '--as', 'A']);
    const vus = lignes((await cli(['tail', `${url}&ro=1`, '--once', '--since', 'all'])).stdout).map(JSON.parse);
    assert.ok(vus.some((m) => m.text === 'visible' && m.verified === true));
  });

  test('rejoindre en ro ne publie aucune annonce', async () => {
    const url = await creer();
    const avant = bus.publishCount;
    await cli(['join', `${url}&ro=1`, '--as', 'observateur']);
    assert.equal(bus.publishCount, avant);
  });
});

describe('AC-11 — repli exponentiel sur 429', () => {
  test('le CLI ne déclare jamais envoyé un message que ntfy a refusé', { timeout: 60_000 }, async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);

    const avant = bus.publishCount;
    bus.force429(99);
    const debut = Date.now();
    const r = await cli(['send', url, 'jamais parti', '--as', 'A'], { timeout: 40_000 });
    const duree = Date.now() - debut;
    bus.force429(0);

    assert.equal(r.code, 4, 'erreur réseau après cinq échecs');
    assert.equal(r.stdout.includes('sent'), false, 'aucun accusé d\'envoi');
    assert.equal(bus.publishCount, avant, 'rien de stocké côté bus');
    assert.match(r.stderr, /429/);
    // 1 + 2 + 4 + 8 s d'attente : le repli est bien exponentiel, pas immédiat.
    assert.ok(duree >= 15_000, `repli trop court : ${duree} ms`);
    assert.ok(duree < 25_000, `repli trop long : ${duree} ms`);
  });

  test('un 429 passager est absorbé sans intervention', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    bus.force429(1);
    const r = await cli(['send', url, 'apres un 429', '--as', 'A']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).sent, true);
    assert.equal(bus.remaining429, 0);
  });
});

// --------------------------------------------------------------------- LOT 2

/** Chemin du fichier de session tel que le CLI l'écrit. */
const cheminSession = (racine, topic) => join(racine, '.agentchat', `${topic}.json`);

/** Fait vieillir une session en place : c'est le temps qui passe, vu du disque. */
function vieillir(racine, topic, heures) {
  const p = cheminSession(racine, topic);
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.createdAt -= heures * 3600_000;
  writeFileSync(p, JSON.stringify(s, null, 2));
  return s;
}

/** Lance `tail` en flux et rend les lignes reçues jusqu'à ce que `fini` soit vrai. */
function tailFlux(args, envSupp, fini, delaiMs = 8000) {
  const proc = spawn(process.execPath, [CLI, 'tail', ...args], { env: env(envSupp) });
  const recus = [];
  const journal = [];
  proc.stderr.on('data', (c) => journal.push(c.toString()));
  const attendu = new Promise((resolve, reject) => {
    let tampon = '';
    proc.stdout.on('data', (c) => {
      tampon += c.toString();
      const parts = tampon.split('\n');
      tampon = parts.pop();
      for (const l of parts.filter((x) => x.trim())) {
        recus.push(JSON.parse(l));
        if (fini(recus)) resolve();
      }
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`rien de concluant en ${delaiMs} ms : ${JSON.stringify(recus)}\n${journal.join('')}`)), delaiMs);
  });
  return { proc, recus, attendu, journal };
}

describe('AC-09 — export chiffré et relecture hors ligne', () => {
  test('trente messages exportés puis relus dans l\'ordre, sans le moindre appel réseau', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    for (let i = 1; i <= 30; i++) {
      const r = await cli(['send', url, `message ${i}`, '--as', 'A']);
      assert.equal(r.code, 0, r.stderr);
    }

    const exp = await cli(['export', url]);
    assert.equal(exp.code, 0, exp.stderr);
    const archive = JSON.parse(exp.stdout);
    assert.equal(archive.v, 1);
    assert.equal(archive.topic, topicDe(url));
    assert.ok(archive.messages.length >= 30);
    assert.match(archive.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

    // L'export est du chiffré : aucun texte n'y est lisible.
    const brut = JSON.stringify(archive);
    assert.equal(brut.includes('message 17'), false, 'l\'export laisse fuir le clair');

    // Le fichier désigne un serveur injoignable : si `replay` touchait au
    // réseau, il échouerait au lieu de rendre les trente messages.
    archive.server = 'http://127.0.0.1:9';
    const fichier = join(home, 'session.json');
    writeFileSync(fichier, JSON.stringify(archive));

    const avant = bus.requestCount;
    const relu = await cli(['replay', fichier]);
    assert.equal(relu.code, 0, relu.stderr);
    assert.equal(bus.requestCount, avant, 'replay a émis une requête réseau');

    const textes = lignes(relu.stdout).map(JSON.parse).filter((m) => m.kind === 'text').map((m) => m.text);
    assert.equal(textes.length, 30);
    assert.deepEqual(textes, Array.from({ length: 30 }, (_, i) => `message ${i + 1}`));
    assert.equal(lignes(relu.stdout).map(JSON.parse).every((m) => m.verified === true), true);
  });

  test('replay accepte la clé par --url quand la session locale a disparu', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'unique', '--as', 'A']);
    const archive = JSON.parse((await cli(['export', url])).stdout);
    const fichier = join(home, 'export.json');
    writeFileSync(fichier, JSON.stringify(archive));

    const vierge = mkdtempSync(join(tmpdir(), 'agentchat-vierge-'));
    try {
      const sans = await cli(['replay', fichier], { env: { HOME: vierge } });
      assert.equal(sans.code, 2, 'sans clé, la relecture doit être refusée, pas devinée');
      assert.match(sans.stderr, /clé introuvable/);

      const avec = await cli(['replay', fichier, '--url', url], { env: { HOME: vierge } });
      assert.equal(avec.code, 0, avec.stderr);
      assert.ok(lignes(avec.stdout).map(JSON.parse).some((m) => m.text === 'unique'));
    } finally {
      rmSync(vierge, { recursive: true, force: true });
    }
  });

  test('un export altéré se relit quand même, en signalant le message atteint', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'intact', '--as', 'A']);
    await cli(['send', url, 'abime', '--as', 'A']);

    const archive = JSON.parse((await cli(['export', url])).stdout);
    const dernier = archive.messages.at(-1);
    dernier.message = altererCorps(dernier.message);
    const fichier = join(home, 'abime.json');
    writeFileSync(fichier, JSON.stringify(archive));

    const relu = await cli(['replay', fichier]);
    assert.equal(relu.code, 5, 'une archive atteinte se signale par le code 5');
    const lus = lignes(relu.stdout).map(JSON.parse);
    assert.ok(lus.some((m) => m.text === 'intact'), 'les messages sains restent lisibles');
    assert.ok(lus.some((m) => m.integrity === 'invalid'));
    assert.equal(lus.some((m) => m.text === 'abime'), false, 'rien de partiel n\'est rendu');
  });

  test('un fichier qui n\'est pas un export est refusé sans deviner', async () => {
    const fichier = join(home, 'pas-un-export.json');
    writeFileSync(fichier, JSON.stringify({ v: 42, topic: 'ac-x' }));
    const r = await cli(['replay', fichier]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /version inattendue|topic/);
  });
});

describe('AC-10 — au-delà du TTL, on lit mais on n\'écrit plus', () => {
  test('écrire est refusé avec le code 3, lire et exporter restent possibles', async () => {
    const url = await creer(['--ttl', '1']);
    const topic = topicDe(url);
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'avant expiration', '--as', 'A']);

    vieillir(home, topic, 2);
    const publiesAvant = bus.messages(topic).length;

    const envoi = await cli(['send', url, 'apres expiration', '--as', 'A']);
    assert.equal(envoi.code, 3, envoi.stderr);
    assert.match(envoi.stderr, /expir/i);
    assert.equal(envoi.stdout.includes('sent'), false);
    assert.equal(bus.messages(topic).length, publiesAvant, 'rien n\'a été publié après le TTL');

    const lecture = await cli(['tail', url, '--once']);
    assert.equal(lecture.code, 0, lecture.stderr);
    assert.ok(lignes(lecture.stdout).map(JSON.parse).some((m) => m.text === 'avant expiration'));

    const exporte = await cli(['export', url]);
    assert.equal(exporte.code, 0, exporte.stderr);
    assert.ok(JSON.parse(exporte.stdout).messages.length >= 2);
  });

  test('le TTL est borné à la création : 0 et 169 heures sont refusés', async () => {
    for (const ttl of ['0', '169', '-1', 'beaucoup']) {
      const r = await cli(['create', '--ttl', ttl, '--server', bus.base]);
      assert.equal(r.code, 2, `--ttl ${ttl}`);
    }
  });

});

describe('AC-15 — métadonnées privées', () => {
  test('le bus ne voit ni le nom du participant ni le kind', async () => {
    const url = await creer(['--private-meta', '--as', 'alice']);
    const topic = topicDe(url);
    await cli(['join', url, '--as', 'alice', '--private-meta']);
    await cli(['send', url, 'discret', '--as', 'alice', '--private-meta']);

    const brut = bus.rawDump(topic);
    assert.equal(brut.includes('alice'), false, 'le participant est visible sur le bus');
    assert.equal(brut.includes('control'), false, 'le kind est visible sur le bus');
    assert.equal(brut.includes('discret'), false);

    for (const m of bus.messages(topic)) {
      assert.equal(m.title, 'ac', 'le titre doit être la constante');
      assert.equal(m.tags[0], 'm', 'le tag de kind doit être la constante');
    }
  });

  test('le CLI restitue auteur et kind depuis le clair chiffré', async () => {
    const url = await creer(['--private-meta', '--as', 'alice']);
    await cli(['join', url, '--as', 'alice', '--private-meta']);
    await cli(['send', url, 'discret', '--as', 'alice']);

    const lus = lignes((await cli(['tail', url, '--once'])).stdout).map(JSON.parse);
    const message = lus.find((m) => m.text === 'discret');
    assert.deepEqual(
      { from: message.from, kind: message.kind, verified: message.verified },
      { from: 'alice', kind: 'text', verified: true },
    );
    assert.ok(lus.some((m) => m.kind === 'control' && m.meta?.type === 'roster'), 'le roster reste lisible');
  });

  test('le choix est mémorisé dans la session : send seul suffit ensuite', async () => {
    const url = await creer(['--private-meta', '--as', 'alice']);
    const topic = topicDe(url);
    assert.equal(JSON.parse(readFileSync(cheminSession(home, topic), 'utf8')).privateMeta, true);
    await cli(['send', url, 'sans le drapeau', '--as', 'alice']);
    assert.equal(bus.messages(topic).at(-1).title, 'ac');
  });
});

describe('AC-16 — migration de topic sans perte', () => {
  test('cinq messages avant, cinq après : le fil est continu pour qui suit', async () => {
    const url = await creer();
    const ancien = topicDe(url);
    await cli(['join', url, '--as', 'A']);
    for (let i = 1; i <= 5; i++) await cli(['send', url, `avant ${i}`, '--as', 'A']);

    const mig = await cli(['migrate', url, '--as', 'A']);
    assert.equal(mig.code, 0, mig.stderr);
    const nouvelleUrl = mig.stdout.trim();
    const nouveau = topicDe(nouvelleUrl);
    assert.notEqual(nouveau, ancien);
    assert.match(nouveau, /^ac-[A-Za-z0-9_-]{32}$/);

    for (let i = 1; i <= 5; i++) await cli(['send', nouvelleUrl, `apres ${i}`, '--as', 'A']);

    const suivi = await cli(['tail', url, '--once']);
    assert.equal(suivi.code, 0, suivi.stderr);
    const textes = lignes(suivi.stdout).map(JSON.parse).filter((m) => m.kind === 'text').map((m) => m.text);
    assert.deepEqual(textes, [
      'avant 1', 'avant 2', 'avant 3', 'avant 4', 'avant 5',
      'apres 1', 'apres 2', 'apres 3', 'apres 4', 'apres 5',
    ]);
  });

  test('un flux ouvert bascule tout seul sur le nouveau topic', { timeout: 30_000 }, async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'avant la bascule', '--as', 'A']);

    const flux = tailFlux([url, '--since', 'all'], {}, (recus) => recus.some((m) => m.text === 'apres la bascule'));
    try {
      await new Promise((r) => setTimeout(r, 400));
      const nouvelleUrl = (await cli(['migrate', url, '--as', 'A'])).stdout.trim();
      await new Promise((r) => setTimeout(r, 400));
      const envoi = await cli(['send', nouvelleUrl, 'apres la bascule', '--as', 'A']);
      assert.equal(envoi.code, 0, envoi.stderr);

      await flux.attendu;
      const textes = flux.recus.filter((m) => m.kind === 'text').map((m) => m.text);
      assert.deepEqual(textes, ['avant la bascule', 'apres la bascule']);
      assert.ok(flux.recus.some((m) => m.kind === 'control' && m.meta?.type === 'migrate'));
    } finally {
      flux.proc.kill('SIGTERM');
    }
  });

  test('--no-follow reste sur l\'ancien topic : la bascule est un choix du lecteur', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    await cli(['send', url, 'ancien', '--as', 'A']);
    const nouvelleUrl = (await cli(['migrate', url, '--as', 'A'])).stdout.trim();
    await cli(['send', nouvelleUrl, 'nouveau', '--as', 'A']);

    const lus = lignes((await cli(['tail', url, '--once', '--no-follow'])).stdout).map(JSON.parse);
    assert.ok(lus.some((m) => m.text === 'ancien'));
    assert.equal(lus.some((m) => m.text === 'nouveau'), false);
  });

  test('un ordre de migration non vérifié n\'est pas suivi', async () => {
    const url = await creer();
    await cli(['join', url, '--as', 'A']);
    const nouvelleUrl = (await cli(['migrate', url, '--as', 'A'])).stdout.trim();
    await cli(['send', nouvelleUrl, 'sur le nouveau topic', '--as', 'A']);

    // La signature de l'ordre est cassée : détourner le salon demanderait donc
    // de connaître Kw, non le seul nom du topic.
    bus.tamper(topicDe(url), (m) => {
      m.tags = m.tags.map((t) => (t.startsWith(TAG_SIG) ? `${TAG_SIG}${'A'.repeat(43)}` : t));
    });

    const lus = lignes((await cli(['tail', url, '--once'])).stdout).map(JSON.parse);
    assert.equal(lus.some((m) => m.text === 'sur le nouveau topic'), false, 'un ordre non vérifié a été suivi');
  });

  test('migrer est refusé en mode observateur', async () => {
    const url = await creer();
    const r = await cli(['migrate', `${url}&ro=1`, '--as', 'observateur']);
    assert.equal(r.code, 3);
  });
});
