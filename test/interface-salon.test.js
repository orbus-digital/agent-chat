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
import {
  ouvrirDemande, lireOctroiPour, lireOctrois, sujetDe, formaterCode,
  AppairageError, VALIDITE_MS,
} from '../lib/appairage.js';
import { encodeB64u, decodeB64u } from '../lib/bytes.js';
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

  test('tant qu\'aucun roster n\'a été lu, la durée de vie est inconnue et l\'écriture reste permise', async () => {
    const salon = ouvrir({ topic: generateTopic(), key: generateKey(), participant: 'bob' });
    await salon.demarrer({ onMessage: () => {} });

    // `ttl.expire` vaut **vrai** avant tout roster : c'est le sens prudent du
    // doute (etat.js), pas une session expirée. Attendre ce seul drapeau ne
    // prouve donc rien — c'est `ttlInconnu` qui dit si le roster est arrivé.
    assert.equal(salon.ttlInconnu, true);
    assert.equal(salon.ttl.expire, true);
    await assert.doesNotReject(() => salon.envoyer('avant tout roster'));
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
    // On attend que le roster ait été **lu**, pas que `ttl.expire` soit vrai :
    // il l'est déjà avant toute lecture, si bien que l'attente serait vide et
    // l'assertion suivante jouée à la course (elle l'était : verte isolément,
    // rouge sous couverture).
    await attendre(() => salon.ttlInconnu === false);
    assert.equal(salon.ttl.expire, true);
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

// ---------------------------------------------------------------- appairage

describe('salon — autoriser un agent par code (ADR-003)', () => {
  /** Un demandeur qui a publié son offre sur le sujet dérivé de son code. */
  async function demandeurEnAttente(ts = Date.now()) {
    const demande = await ouvrirDemande({ ts });
    await publish({
      base: bus.base, topic: demande.sujet, body: demande.offre.body,
      title: demande.offre.title, tags: demande.offre.tags,
    });
    return demande;
  }

  test('le membre autorise, et le demandeur ouvre exactement la clé du salon', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const demande = await demandeurEnAttente();

    const salon = ouvrir({ topic, key, participant: 'membre' });
    await salon.demarrer({ onMessage: () => {} });
    await salon.annoncer({ ttlH: 2, createdAt: Date.now() });
    await attendre(() => salon.participants.includes('membre'));

    assert.deepEqual(await salon.autoriser(formaterCode(demande.code)),
      { code: demande.code, display: formaterCode(demande.code) });

    const octroi = bus.messages(demande.sujet).at(-1);
    const invitation = await lireOctroiPour({ demande, raw: octroi });
    assert.equal(invitation.topic, topic);
    assert.deepEqual(decodeB64u(invitation.k), key);
    assert.equal(invitation.ttlH, 2, 'la durée annoncée par le salon voyage avec l\'invitation');
    assert.ok(invitation.participants.includes('membre'));
  });

  test('rien de la session n\'est lisible sur le sujet d\'appairage', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const demande = await demandeurEnAttente();
    const salon = ouvrir({ topic, key, participant: 'membre' });
    await salon.demarrer({ onMessage: () => {} });
    await salon.autoriser(demande.code);

    const brut = bus.rawDump(demande.sujet);
    assert.equal(brut.includes(topic), false);
    assert.equal(brut.includes(encodeB64u(key)), false);
    assert.equal(brut.includes(demande.code), false);
  });

  test('un observateur ne fait entrer personne', async () => {
    const demande = await demandeurEnAttente();
    const salon = ouvrir({ topic: generateTopic(), key: generateKey(), ro: true });
    await salon.demarrer({ onMessage: () => {} });
    await assert.rejects(() => salon.autoriser(demande.code), /observateur/i);
    assert.equal(lireOctrois(bus.messages(demande.sujet)).length, 0);
  });

  test('une session expirée n\'admet plus personne', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const demande = await demandeurEnAttente();
    const t0 = 1_780_000_000_000;
    const salon = ouvrir({ topic, key, participant: 'membre', now: () => t0 });
    await salon.demarrer({ onMessage: () => {} });
    await salon.annoncer({ ttlH: 2, createdAt: t0 - 3 * 3600_000 });
    await attendre(() => salon.ttl.expire === true);

    await assert.rejects(() => salon.autoriser(demande.code), /expir/i);
    assert.equal(lireOctrois(bus.messages(demande.sujet)).length, 0);
  });

  test('SUBSTITUTION : une clé publique qui ne répond pas du code est refusée', async () => {
    const adversaire = await ouvrirDemande();
    const codeAnnonce = 'KXR72M4Q9T';
    const sujetVise = await sujetDe(codeAnnonce);
    await publish({
      base: bus.base, topic: sujetVise, body: adversaire.offre.body,
      title: adversaire.offre.title, tags: adversaire.offre.tags,
    });

    const salon = ouvrir({ topic: generateTopic(), key: generateKey(), participant: 'membre' });
    await salon.demarrer({ onMessage: () => {} });
    await assert.rejects(
      () => salon.autoriser(codeAnnonce),
      (e) => e instanceof AppairageError && e.raison === 'aucune-offre',
    );
    assert.equal(lireOctrois(bus.messages(sujetVise)).length, 0);
  });

  test('DÉJÀ CONSOMMÉ : le second membre est refusé, sans état partagé avec le premier', async () => {
    const demande = await demandeurEnAttente();
    const premier = ouvrir({ topic: generateTopic(), key: generateKey(), participant: 'membre-1' });
    await premier.demarrer({ onMessage: () => {} });
    await premier.autoriser(demande.code);

    const second = ouvrir({ topic: generateTopic(), key: generateKey(), participant: 'membre-2' });
    await second.demarrer({ onMessage: () => {} });
    await assert.rejects(
      () => second.autoriser(demande.code),
      (e) => e instanceof AppairageError && e.raison === 'deja-consomme',
    );
    assert.equal(lireOctrois(bus.messages(demande.sujet)).length, 1);
  });

  test('EXPIRÉ : au-delà de cinq minutes, le code ne vaut plus rien', async () => {
    const t0 = 1_780_000_000_000;
    const demande = await demandeurEnAttente(t0);
    const salon = ouvrir({ topic: generateTopic(), key: generateKey(), participant: 'membre', now: () => t0 + VALIDITE_MS });
    await salon.demarrer({ onMessage: () => {} });
    await assert.rejects(
      () => salon.autoriser(demande.code),
      (e) => e instanceof AppairageError && e.raison === 'code-expire',
    );
  });

  test('un code mal saisi est refusé avant toute requête', async () => {
    const salon = ouvrir({ topic: generateTopic(), key: generateKey(), participant: 'membre' });
    await salon.demarrer({ onMessage: () => {} });
    const avant = bus.requestCount;
    await assert.rejects(
      () => salon.autoriser('PAS-UN-CODE'),
      (e) => e instanceof AppairageError && e.raison === 'code-invalide',
    );
    assert.equal(bus.requestCount, avant, 'un code illisible ne doit rien demander au bus');
  });

  test('sans durée annoncée, l\'invitation n\'en invente pas (R4, D-09)', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const demande = await demandeurEnAttente();
    const salon = ouvrir({ topic, key, participant: 'membre' });
    await salon.demarrer({ onMessage: () => {} });

    await salon.autoriser(demande.code);
    const invitation = await lireOctroiPour({ demande, raw: bus.messages(demande.sujet).at(-1) });
    assert.equal('ttlH' in invitation, false);
    assert.equal('createdAt' in invitation, false);
  });
});
