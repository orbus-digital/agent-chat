/**
 * Les deux verbes d'appairage, éprouvés sans lancer de processus : `run()`
 * reçoit son horloge, son `$HOME`, sa sortie et ses minuteurs.
 *
 * C'est le seul moyen d'éprouver un code **expiré** sans attendre cinq minutes,
 * et une **attente qui expire** sans en attendre cinq de plus.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import { run, EXIT } from '../lib/cli.js';
import { sujetDe, formaterCode, VALIDITE_MS, lireOffres, lireOctrois } from '../lib/appairage.js';
import { deriveWriteKey, generateTopic, generateKey } from '../lib/crypto.js';
import { decodeMessage } from '../lib/protocol.js';
import { decodeB64u } from '../lib/bytes.js';
import { buildSessionUrl } from '../lib/url.js';

const UI = 'https://exemple.test/chat/';

let bus;
let home;
let horloge;

before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agentchat-p-')); horloge = 1_780_000_000_000; });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Des minuteurs qui ne se déclenchent jamais : l'attente ne s'interrompt que par un octroi. */
const minuteurMuet = { poser: () => 0, retirer: () => {} };
/** Des minuteurs qui se déclenchent tout de suite : l'attente expire. */
const minuteurImmediat = { poser: (fn) => setTimeout(fn, 0), retirer: (id) => clearTimeout(id) };

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
    allowInsecure: true,
    minuteur: minuteurMuet,
    ...extra,
  });
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
}

const creer = async (argv = []) => (await lancer(['create', '--server', bus.base, ...argv])).out[0];
const topicDe = (url) => new URLSearchParams(url.slice(url.indexOf('#') + 1)).get('t');
const cleDe = (url) => new URLSearchParams(url.slice(url.indexOf('#') + 1)).get('k');
const sessionDe = (topic) => JSON.parse(readFileSync(join(home, '.agentchat', `${topic}.json`), 'utf8'));

/**
 * Lance `pair` et rend la main **dès que le code est imprimé** : c'est là que
 * le demandeur commence à attendre, et donc là qu'un membre peut autoriser.
 */
async function demanderAppairage(argv = [], extra = {}) {
  const out = [];
  const err = [];
  let annonce;
  const annonceFaite = new Promise((r) => { annonce = r; });

  const fini = run(['pair', '--server', bus.base, ...argv], {
    stdout: (l) => { out.push(l); if (out.length === 1) annonce(JSON.parse(l)); },
    stderr: (l) => err.push(l),
    home,
    now: () => horloge,
    sleep: async () => {},
    uiBase: UI,
    allowInsecure: true,
    minuteur: minuteurMuet,
    ...extra,
  });
  // `fini` peut échouer avant d'imprimer : on ne doit pas attendre indéfiniment.
  const annoncee = await Promise.race([annonceFaite, fini.then(() => null)]);
  return { annonce: annoncee, fini, out, err };
}

/** Attend que le sujet d'appairage porte au moins `n` messages. */
async function attendreSur(sujet, n) {
  for (let i = 0; i < 400; i++) {
    if (bus.messages(sujet).length >= n) return bus.messages(sujet);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`rien n'est arrivé sur ${sujet} (attendu ${n})`);
}

describe('pair — le demandeur annonce un code et attend', () => {
  test('imprime un code de 10 caractères, groupé pour être dicté', async () => {
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    await fini;
    assert.equal(annonce.code.length, 10);
    assert.equal(annonce.display, formaterCode(annonce.code));
    assert.equal(annonce.expiresAt, horloge + VALIDITE_MS);
    assert.equal(annonce.waiting, true);
  });

  test('publie sa clé publique sur le sujet dérivé du code, et rien d\'autre', async () => {
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    await fini;
    const sujet = await sujetDe(annonce.code);
    const messages = bus.messages(sujet);
    assert.equal(messages.length, 1);
    assert.equal(lireOffres(messages).length, 1);
    assert.equal(messages[0].title, 'ac', 'le bus n\'apprend pas qui demande');
  });

  test('le code dicté suffit à retrouver le rendez-vous, et rien d\'autre n\'y mène', async () => {
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    await fini;
    assert.equal(annonce.topic, await sujetDe(annonce.code));
    assert.match(annonce.topic, /^acp-/);
  });

  test('--as est requis : on n\'entre pas dans un salon sans nom', async () => {
    const r = await lancer(['pair', '--server', bus.base]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /--as/);
    assert.equal(bus.publishCount > 0 ? lireOffres(bus.messages('acp-rien')).length : 0, 0);
  });

  test('sans autorisation, l\'attente finit par expirer — code 3, rien d\'écrit', async () => {
    const { fini, err } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    assert.equal(await fini, EXIT.READONLY);
    assert.match(err.join('\n'), /expir/i);
    assert.equal(existsSync(join(home, '.agentchat')), false, 'aucune session ne doit être écrite');
  });
});

describe('authorize — un membre autorise, le demandeur entre', () => {
  test('l\'aller-retour complet : le demandeur reçoit une session utilisable', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini, out } = await demanderAppairage(['--as', 'agent-b']);
    const sujet = await sujetDe(annonce.code);
    await attendreSur(sujet, 1);

    const a = await lancer(['authorize', url, formaterCode(annonce.code)]);
    assert.equal(a.code, EXIT.OK, a.stderr);
    assert.deepEqual(JSON.parse(a.out[0]), { code: annonce.code, topic: topicDe(url), granted: true });

    assert.equal(await fini, EXIT.OK);
    const lien = out[out.length - 1];
    assert.equal(topicDe(lien), topicDe(url));
    assert.equal(cleDe(lien), cleDe(url), 'c\'est bien la clé du salon qui a été transmise');
  });

  test('la session locale du demandeur est écrite en 600, avec la durée annoncée par le salon', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b']);
    await attendreSur(await sujetDe(annonce.code), 1);
    await lancer(['authorize', url, annonce.code]);
    assert.equal(await fini, EXIT.OK);

    const chemin = join(home, '.agentchat', `${topicDe(url)}.json`);
    assert.equal(statSync(chemin).mode & 0o777, 0o600);
    const s = sessionDe(topicDe(url));
    assert.equal(s.participant, 'agent-b');
    assert.equal(s.ro, false);
    assert.equal(s.ttlH, 2, 'la durée vient du salon, elle ne s\'invente pas (R4)');
    assert.equal(s.ttlSuppose, false);
  });

  test('le demandeur s\'annonce au roster : les autres savent qui est entré', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b']);
    await attendreSur(await sujetDe(annonce.code), 1);
    await lancer(['authorize', url, annonce.code]);
    assert.equal(await fini, EXIT.OK);

    const topic = topicDe(url);
    const key = decodeB64u(cleDe(url));
    const kw = await deriveWriteKey(key);
    const rosters = [];
    for (const raw of bus.messages(topic)) {
      try {
        const m = await decodeMessage({ key, kw, topic, raw });
        if (m?.kind === 'control' && m.meta?.type === 'roster') rosters.push(m);
      } catch { /* pas un roster */ }
    }
    assert.ok(rosters.at(-1).meta.participants.includes('agent-b'));
    assert.ok(rosters.at(-1).meta.participants.includes('createur'));
  });

  test('rien de la session ne passe en clair par le sujet d\'appairage', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b']);
    const sujet = await sujetDe(annonce.code);
    await attendreSur(sujet, 1);
    await lancer(['authorize', url, annonce.code]);
    assert.equal(await fini, EXIT.OK);

    const brut = bus.rawDump(sujet);
    assert.ok(brut.length > 0);
    assert.equal(brut.includes(cleDe(url)), false, 'la clé de session est lisible sur le sujet d\'appairage');
    assert.equal(brut.includes(topicDe(url)), false, 'le topic du salon est lisible sur le sujet d\'appairage');
    assert.equal(brut.includes(annonce.code), false, 'le code lui-même est lisible sur le sujet');
    assert.equal(lireOctrois(bus.messages(sujet)).length, 1);
  });
});

describe('authorize — les trois refus', () => {
  test('SUBSTITUTION : aucune clé ne répond de ce code — code 5, rien de publié', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const sujet = await sujetDe('KXR72M4Q9T');
    const avant = bus.messages(sujet).length;

    const r = await lancer(['authorize', url, 'KXR7-2M4Q-9T']);
    assert.equal(r.code, EXIT.INTEGRITY);
    assert.match(r.stderr, /substitu|correspond/i);
    assert.equal(bus.messages(sujet).length, avant, 'un refus ne publie rien');
  });

  test('SUBSTITUTION : la clé d\'un adversaire publiée sur le bon sujet ne suffit pas', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    // L'adversaire ouvre SA demande : il obtient une vraie paire ECDH, et une
    // offre parfaitement bien formée — mais dont l'empreinte est SON code.
    const { annonce: adversaire, fini } = await demanderAppairage(['--as', 'adversaire'], { minuteur: minuteurImmediat });
    await fini;
    const offreAdverse = bus.messages(await sujetDe(adversaire.code))[0];

    // Il la republie telle quelle sur le sujet du code qu'un membre s'apprête
    // à saisir, en espérant qu'on scelle la clé de session à son intention.
    const codeAnnonce = 'KXR72M4Q9T';
    const sujetVise = await sujetDe(codeAnnonce);
    await fetch(`${bus.base}/${sujetVise}`, {
      method: 'POST', headers: { 'X-Title': 'ac', 'X-Tags': 'pair-offer' }, body: offreAdverse.message,
    });
    assert.equal(lireOffres(bus.messages(sujetVise)).length, 1, 'la clé substituée est bien sur le bon sujet');

    const r = await lancer(['authorize', url, codeAnnonce]);
    assert.equal(r.code, EXIT.INTEGRITY, r.stderr);
    assert.equal(lireOctrois(bus.messages(sujetVise)).length, 0, 'aucune clé de session n\'a été scellée');
  });

  test('EXPIRÉ : au-delà de cinq minutes, le membre refuse — code 3', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    await fini;
    const sujet = await sujetDe(annonce.code);

    horloge += VALIDITE_MS;
    const r = await lancer(['authorize', url, annonce.code]);
    assert.equal(r.code, EXIT.READONLY);
    assert.match(r.stderr, /expir/i);
    assert.equal(lireOctrois(bus.messages(sujet)).length, 0);
  });

  test('DÉJÀ CONSOMMÉ : un code ne sert qu\'une fois — code 3', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b']);
    const sujet = await sujetDe(annonce.code);
    await attendreSur(sujet, 1);

    assert.equal((await lancer(['authorize', url, annonce.code])).code, EXIT.OK);
    assert.equal(await fini, EXIT.OK);

    const r = await lancer(['authorize', url, annonce.code]);
    assert.equal(r.code, EXIT.READONLY);
    assert.match(r.stderr, /consomm/i);
    assert.equal(lireOctrois(bus.messages(sujet)).length, 1, 'le second octroi n\'a pas été publié');
  });
});

describe('authorize — qui a le droit d\'autoriser', () => {
  test('un observateur ne fait pas entrer : code 3', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    await fini;

    const r = await lancer(['authorize', `${url}&ro=1`, annonce.code]);
    assert.equal(r.code, EXIT.READONLY);
    assert.match(r.stderr, /observateur/i);
    assert.equal(lireOctrois(bus.messages(await sujetDe(annonce.code))).length, 0);
  });

  test('une session expirée n\'invite personne : code 3', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b'], { minuteur: minuteurImmediat });
    await fini;

    horloge += 3 * 3600_000;
    const r = await lancer(['authorize', url, annonce.code]);
    assert.equal(r.code, EXIT.READONLY);
    assert.match(r.stderr, /expir/i);
  });

  test('un code mal saisi est une erreur d\'usage, pas une attaque : code 2', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const r = await lancer(['authorize', url, 'PAS-UN-CODE']);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /code d'appairage/i);
  });

  test('le code est obligatoire, et l\'URL aussi', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    assert.equal((await lancer(['authorize', url])).code, EXIT.USAGE);
    assert.equal((await lancer(['authorize'])).code, EXIT.USAGE);
  });
});

describe('authorize — une durée de vie ne s\'invente pas (R4, D-09)', () => {
  test('sans roster lisible, l\'invitation n\'annonce aucune durée, et le demandeur la sait supposée', async () => {
    // Un salon dont le membre ne connaît rien : ni session locale, ni roster
    // dans le cache du bus. Il a la clé, il peut donc autoriser — mais il n'a
    // aucune durée à annoncer, et il n'en invente pas.
    const url = buildSessionUrl({
      topic: generateTopic(), key: generateKey(), server: bus.base, uiBase: UI, allowInsecure: true,
    });
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b']);
    await attendreSur(await sujetDe(annonce.code), 1);
    assert.equal((await lancer(['authorize', url, annonce.code])).code, EXIT.OK);
    assert.equal(await fini, EXIT.OK);

    const s = sessionDe(topicDe(url));
    assert.equal(s.ttlSuppose, true, 'une durée supposée doit être marquée comme telle');
    assert.equal(s.ttlH, 24, 'à défaut, la valeur par défaut — pour soi seul');
  });

  test('quand le salon annonce sa durée, elle est transmise telle quelle', async () => {
    const url = await creer(['--ttl', '2', '--as', 'createur']);
    const { annonce, fini } = await demanderAppairage(['--as', 'agent-b']);
    await attendreSur(await sujetDe(annonce.code), 1);
    await lancer(['authorize', url, annonce.code]);
    assert.equal(await fini, EXIT.OK);
    assert.equal(sessionDe(topicDe(url)).ttlH, 2);
    assert.equal(sessionDe(topicDe(url)).ttlSuppose, false);
  });
});
