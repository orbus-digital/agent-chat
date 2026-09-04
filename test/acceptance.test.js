/**
 * Critères d'acceptation de la spec, un test par critère, éprouvés de bout en
 * bout : vrais processus `agentchat`, vrai HTTP, serveur ntfy local.
 *
 * Lot 1 : AC-01, AC-02, AC-03, AC-04, AC-05, AC-07, AC-08, AC-11.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import { TAG_SIG } from '../lib/protocol.js';

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
