/**
 * Le salon vu de l'interface : ce que la page fait réellement du bus.
 * Éprouvé contre le serveur ntfy de test, sans navigateur — `Salon` n'utilise
 * que `fetch`, exactement comme dans un onglet.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import { generateKey, generateTopic, deriveWriteKey } from '../lib/crypto.js';
import { encodeMessage } from '../lib/protocol.js';
import { publish } from '../lib/ntfy.js';
import { Salon } from '../web/js/salon.js';
import { altererCorps } from './helpers/alterer.js';

let bus;
before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });

let salons;
beforeEach(() => { salons = []; });
afterEach(() => { for (const s of salons) s.arreter(); });

function ouvrir(options) {
  const s = new Salon({ server: bus.base, ...options });
  salons.push(s);
  return s;
}

/** Publie un message comme le ferait un pair, sans passer par le salon. */
async function publierPair({ topic, key, from, kind = 'text', text, meta, privateMeta = false }) {
  const env = await encodeMessage({ key, kw: await deriveWriteKey(key), topic, from, kind, text, meta, privateMeta });
  return publish({ base: bus.base, topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig });
}

const attendre = (predicat, delai = 5000) => new Promise((resolve, reject) => {
  const debut = Date.now();
  const battement = setInterval(() => {
    if (predicat()) { clearInterval(battement); resolve(Date.now() - debut); }
    else if (Date.now() - debut > delai) { clearInterval(battement); reject(new Error('délai dépassé')); }
  }, 20);
});

describe('salon — flux déchiffré en direct (AC-06)', () => {
  test('un message publié par un pair apparaît déchiffré, avec auteur, heure, kind et état vérifié', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const recus = [];
    const salon = ouvrir({ topic, key });
    await salon.demarrer({ onMessage: (m) => recus.push(m) });

    await publierPair({ topic, key, from: 'alice', text: 'bonjour' });
    await attendre(() => recus.some((m) => m.texte === 'bonjour'));

    const v = recus.find((m) => m.texte === 'bonjour');
    assert.equal(v.auteur, 'alice');
    assert.equal(v.kind, 'text');
    assert.equal(v.verifie, true);
    assert.match(v.heure, /^\d{2}:\d{2}$/);
  });

  test('l\'historique déjà présent sur le bus est rattrapé à l\'ouverture', async () => {
    const topic = generateTopic();
    const key = generateKey();
    await publierPair({ topic, key, from: 'alice', text: 'avant ouverture' });

    const recus = [];
    const salon = ouvrir({ topic, key });
    await salon.demarrer({ onMessage: (m) => recus.push(m) });
    await attendre(() => recus.some((m) => m.texte === 'avant ouverture'));
  });

  test('un doublon n\'est pas affiché deux fois (R3)', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const recus = [];
    const salon = ouvrir({ topic, key });
    await salon.demarrer({ onMessage: (m) => recus.push(m) });

    const env = await encodeMessage({ key, kw: await deriveWriteKey(key), topic, from: 'alice', kind: 'text', text: 'unique' });
    for (let i = 0; i < 2; i++) {
      await publish({ base: bus.base, topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig });
    }
    await attendre(() => recus.some((m) => m.texte === 'unique'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(recus.filter((m) => m.texte === 'unique').length, 1);
  });

  test('un message altéré est signalé sans rendre de texte (AC-05)', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const recus = [];
    const salon = ouvrir({ topic, key });
    await salon.demarrer({ onMessage: (m) => recus.push(m) });

    await publierPair({ topic, key, from: 'alice', text: 'sera altéré' });
    await attendre(() => recus.length > 0);
    bus.tamper(topic, (m) => { m.message = altererCorps(m.message); });

    const autre = ouvrir({ topic, key });
    const vus = [];
    await autre.demarrer({ onMessage: (m) => vus.push(m) });
    await attendre(() => vus.some((m) => m.invalide));
    const casse = vus.find((m) => m.invalide);
    assert.equal(casse.texte, '');
    assert.match(casse.mention, /intégrité/i);
  });

  test('les métadonnées privées sont restituées depuis le clair chiffré (AC-15)', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const recus = [];
    const salon = ouvrir({ topic, key });
    await salon.demarrer({ onMessage: (m) => recus.push(m) });

    await publierPair({ topic, key, from: 'alice', kind: 'control', text: 'discret', privateMeta: true });
    await attendre(() => recus.length > 0);
    assert.equal(recus[0].auteur, 'alice');
    assert.equal(recus[0].control, true);
    assert.equal(bus.messages(topic)[0].title, 'ac');
  });
});

describe('salon — écriture et mode observateur (AC-06, AC-08)', () => {
  test('un participant publie, et son message revient dans le fil', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const recus = [];
    const salon = ouvrir({ topic, key, participant: 'bob' });
    await salon.demarrer({ onMessage: (m) => recus.push(m) });

    await salon.envoyer('depuis la page');
    await attendre(() => recus.some((m) => m.texte === 'depuis la page'));
    assert.equal(recus.find((m) => m.texte === 'depuis la page').auteur, 'bob');
  });

  test('un observateur ne publie pas — le refus est explicite', async () => {
    const salon = ouvrir({ topic: generateTopic(), key: generateKey(), ro: true, participant: 'oeil' });
    await assert.rejects(() => salon.envoyer('je regarde'), /observateur/i);
  });

  test('un participant sans nom ne publie pas non plus', async () => {
    const salon = ouvrir({ topic: generateTopic(), key: generateKey() });
    await assert.rejects(() => salon.envoyer('anonyme'), /nom/i);
  });

  test('passé le TTL annoncé par le roster, l\'écriture est refusée (AC-10)', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const salon = ouvrir({ topic, key, participant: 'bob', now: () => 5_000_000_000_000 });
    const recus = [];
    await salon.demarrer({ onMessage: (m) => recus.push(m) });

    await publierPair({
      topic, key, from: 'alice', kind: 'control', text: 'roster',
      meta: { type: 'roster', participants: ['alice'], ttlH: 1, createdAt: 1_780_000_000_000 },
    });
    await attendre(() => salon.ttl.expire === true);
    await assert.rejects(() => salon.envoyer('trop tard'), /expir/i);
  });
});

describe('salon — roster et santé', () => {
  test('le roster se remplit des participants annoncés et vérifiés', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const salon = ouvrir({ topic, key });
    await salon.demarrer({ onMessage: () => {} });

    await publierPair({
      topic, key, from: 'alice', kind: 'control', text: 'roster',
      meta: { type: 'roster', participants: ['alice', 'bob'], ttlH: 24, createdAt: Date.now() },
    });
    await attendre(() => salon.participants.length === 2);
    assert.deepEqual(salon.participants, ['alice', 'bob']);
  });

  test('la santé du bus est verte quand il répond, rouge sinon (AC-13)', async () => {
    const salon = ouvrir({ topic: generateTopic(), key: generateKey() });
    assert.deepEqual(await salon.sante(), { healthy: true });

    bus.healthy = false;
    try {
      assert.equal((await salon.sante()).healthy, false);
    } finally {
      bus.healthy = true;
    }
  });

  test('un bus injoignable donne une santé fausse, pas une exception', async () => {
    const salon = new Salon({ topic: generateTopic(), key: generateKey(), server: 'http://127.0.0.1:9' });
    const s = await salon.sante();
    assert.equal(s.healthy, false);
    assert.ok(s.raison);
  });
});

describe('salon — archive (AC-09)', () => {
  test('exporter puis importer restitue la conversation, dans l\'ordre', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const salon = ouvrir({ topic, key, participant: 'alice' });
    await salon.demarrer({ onMessage: () => {} });
    for (let i = 1; i <= 5; i++) await salon.envoyer(`ligne ${i}`);
    await attendre(() => bus.messages(topic).length >= 5);

    const archive = await salon.exporter();
    assert.equal(archive.v, 1);
    assert.equal(archive.topic, topic);
    assert.equal(JSON.stringify(archive).includes('ligne 3'), false, 'un export laisse fuir le clair');

    const relus = [];
    const lecteur = ouvrir({ topic, key });
    await lecteur.importer(archive, (m) => relus.push(m));
    assert.deepEqual(relus.filter((m) => !m.control).map((m) => m.texte), ['ligne 1', 'ligne 2', 'ligne 3', 'ligne 4', 'ligne 5']);
  });

  test('importer un fichier qui n\'est pas un export est refusé', async () => {
    const salon = ouvrir({ topic: generateTopic(), key: generateKey() });
    await assert.rejects(() => salon.importer({ v: 9 }, () => {}), /version/i);
  });
});

describe('salon — migration (AC-16)', () => {
  test('un ordre vérifié fait basculer le flux sur le nouveau topic', async () => {
    const ancien = generateTopic();
    const nouveau = generateTopic();
    const key = generateKey();
    const recus = [];
    const migrations = [];

    const salon = ouvrir({ topic: ancien, key });
    await salon.demarrer({ onMessage: (m) => recus.push(m), onMigration: (t) => migrations.push(t) });

    await publierPair({ topic: ancien, key, from: 'alice', text: 'avant' });
    await attendre(() => recus.some((m) => m.texte === 'avant'));

    await publierPair({
      topic: ancien, key, from: 'alice', kind: 'control', text: 'migrate',
      meta: { type: 'migrate', topic: nouveau },
    });
    await attendre(() => migrations.includes(nouveau));

    await publierPair({ topic: nouveau, key, from: 'alice', text: 'apres' });
    await attendre(() => recus.some((m) => m.texte === 'apres'));

    assert.deepEqual(recus.filter((m) => !m.control).map((m) => m.texte), ['avant', 'apres']);
    assert.equal(salon.topic, nouveau);
  });
});
