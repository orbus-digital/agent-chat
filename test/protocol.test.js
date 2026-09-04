import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, generateTopic, deriveWriteKey, IntegrityError, nonceOf } from '../lib/crypto.js';
import { signBody } from '../lib/sign.js';
import {
  encodeMessage, decodeMessage, ReplayGuard, KINDS, TAG_TS, TAG_SIG,
  PRIVATE_TITLE, PRIVATE_KIND,
} from '../lib/protocol.js';
import { encodeB64u, decodeB64u, utf8 } from '../lib/bytes.js';

const topic = generateTopic();
const key = generateKey();
const kw = await deriveWriteKey(key);

/** Reproduit ce que ntfy renvoie à partir de ce que nous publions. */
const commeNtfy = (env, id = 'idAAA1') => ({
  id, time: Math.floor(env.ts / 1000), event: 'message', topic,
  title: env.title, message: env.body, tags: env.tags,
});

describe('protocol — enveloppe', () => {
  test('publie un corps chiffré, un titre en clair et les tags de métadonnées', async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    assert.match(env.body, /^[A-Za-z0-9_-]+$/);
    assert.equal(env.title, 'alice');
    assert.equal(env.tags[0], 'text');
    assert.ok(env.tags.some((t) => t.startsWith(TAG_TS)));
    assert.ok(env.tags.some((t) => t.startsWith(TAG_SIG)));
  });

  test('aucune trace du clair dans ce qui part sur le réseau (AC-03)', async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const surLeFil = JSON.stringify(commeNtfy(env));
    assert.equal(surLeFil.includes('ping'), false);
    assert.equal(surLeFil.includes(encodeB64u(utf8('ping'))), false);
  });

  test("un aller-retour rend le texte, l'auteur, le kind et l'état vérifié", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const m = await decodeMessage({ key, kw, topic, raw: commeNtfy(env) });
    assert.equal(m.text, 'ping');
    assert.equal(m.from, 'alice');
    assert.equal(m.kind, 'text');
    assert.equal(m.verified, true);
    assert.equal(m.id, 'idAAA1');
    assert.equal(m.ts, env.ts);
    assert.equal(m.privateMeta, false);
  });

  test('transporte des métadonnées structurées (roster, migrate)', async () => {
    const meta = { type: 'roster', participants: ['alice'], ttlH: 2 };
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'control', text: 'roster', meta });
    assert.deepEqual((await decodeMessage({ key, kw, topic, raw: commeNtfy(env) })).meta, meta);
  });

  test('refuse un kind hors du contrat', async () => {
    await assert.rejects(() => encodeMessage({ key, kw, topic, from: 'a', kind: 'sournois', text: 'x' }), /kind/);
    assert.deepEqual(KINDS, ['text', 'file', 'control']);
  });

  test("refuse un nom d'auteur vide ou porteur d'un séparateur d'AAD", async () => {
    for (const from of ['', '   ', 'a|b', 'x'.repeat(65)]) {
      await assert.rejects(() => encodeMessage({ key, kw, topic, from, kind: 'text', text: 'x' }), /auteur/, from);
    }
  });
});

describe('protocol — métadonnées privées (AC-15)', () => {
  test('les en-têtes publiés ne portent ni le nom du participant ni le kind', async () => {
    const env = await encodeMessage({
      key, kw, topic, from: 'alice', kind: 'control', text: 'ordre', privateMeta: true,
    });
    assert.equal(env.title, PRIVATE_TITLE);
    assert.equal(env.tags[0], PRIVATE_KIND);
    const surLeFil = JSON.stringify(commeNtfy(env));
    assert.equal(surLeFil.includes('alice'), false, 'le participant est visible');
    assert.equal(surLeFil.includes('control'), false, 'le kind est visible');
  });

  test('le destinataire restitue auteur et kind depuis le clair chiffré', async () => {
    const env = await encodeMessage({
      key, kw, topic, from: 'alice', kind: 'control', text: 'ordre', privateMeta: true,
    });
    const m = await decodeMessage({ key, kw, topic, raw: commeNtfy(env) });
    assert.equal(m.from, 'alice');
    assert.equal(m.kind, 'control');
    assert.equal(m.text, 'ordre');
    assert.equal(m.verified, true);
    assert.equal(m.privateMeta, true);
  });

  test('les deux constantes sont identiques d\'un message à l\'autre — rien à corréler', async () => {
    const a = await encodeMessage({ key, kw, topic, from: 'alice', text: 'un', privateMeta: true });
    const b = await encodeMessage({ key, kw, topic, from: 'bob', kind: 'control', text: 'deux', privateMeta: true });
    assert.equal(a.title, b.title);
    assert.equal(a.tags[0], b.tags[0]);
  });

  test("l'AAD reste celle des constantes publiées : réécrire le titre est détecté", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', text: 'un', privateMeta: true });
    const raw = commeNtfy(env);
    raw.title = 'alice';
    await assert.rejects(() => decodeMessage({ key, kw, topic, raw }), IntegrityError);
  });

  test('un message ordinaire et un message privé coexistent dans le même fil', async () => {
    const clair = await encodeMessage({ key, kw, topic, from: 'bob', text: 'visible' });
    const prive = await encodeMessage({ key, kw, topic, from: 'alice', text: 'discret', privateMeta: true });
    assert.equal((await decodeMessage({ key, kw, topic, raw: commeNtfy(clair) })).from, 'bob');
    assert.equal((await decodeMessage({ key, kw, topic, raw: commeNtfy(prive) })).from, 'alice');
  });
});

describe('protocol — lecture défensive', () => {
  test('signature altérée : le message reste lisible mais non vérifié (AC-04)', async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const raw = commeNtfy(env);
    raw.tags = raw.tags.map((t) => (t.startsWith(TAG_SIG) ? `${TAG_SIG}${'A'.repeat(43)}` : t));
    const m = await decodeMessage({ key, kw, topic, raw });
    assert.equal(m.verified, false);
    assert.equal(m.text, 'ping');
  });

  test('signature absente : non vérifié (AC-04)', async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const raw = commeNtfy(env);
    raw.tags = raw.tags.filter((t) => !t.startsWith(TAG_SIG));
    assert.equal((await decodeMessage({ key, kw, topic, raw })).verified, false);
  });

  test("signature valide mais d'un corps voisin : non vérifié", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const raw = commeNtfy(env);
    const usurpee = await signBody(kw, 'autre-corps');
    raw.tags = raw.tags.map((t) => (t.startsWith(TAG_SIG) ? TAG_SIG + usurpee : t));
    assert.equal((await decodeMessage({ key, kw, topic, raw })).verified, false);
  });

  test("chiffré altéré : rien n'est rendu (AC-05)", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const raw = commeNtfy(env);
    const octets = decodeB64u(raw.message);
    octets[octets.length - 1] ^= 0x01;
    raw.message = encodeB64u(octets);
    await assert.rejects(() => decodeMessage({ key, kw, topic, raw }), IntegrityError);
  });

  test("auteur réécrit par un tiers : l'AAD le détecte (AC-05)", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const raw = commeNtfy(env);
    raw.title = 'mallory';
    await assert.rejects(() => decodeMessage({ key, kw, topic, raw }), IntegrityError);
  });

  test("horodatage réécrit : l'AAD le détecte (AC-05)", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    const raw = commeNtfy(env);
    raw.tags = raw.tags.map((t) => (t.startsWith(TAG_TS) ? `${TAG_TS}${env.ts + 1}` : t));
    await assert.rejects(() => decodeMessage({ key, kw, topic, raw }), IntegrityError);
  });

  test("tag d'horodatage absent ou difforme : rejet explicite", async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    for (const remplacement of [null, `${TAG_TS}abc`]) {
      const raw = commeNtfy(env);
      raw.tags = remplacement === null
        ? raw.tags.filter((t) => !t.startsWith(TAG_TS))
        : raw.tags.map((t) => (t.startsWith(TAG_TS) ? remplacement : t));
      await assert.rejects(() => decodeMessage({ key, kw, topic, raw }), IntegrityError);
    }
  });

  test("un message qui n'est pas des nôtres ne fait pas tomber le client", async () => {
    for (const raw of [{ id: 'x', message: 'pas-du-nôtre', title: 'a', tags: ['text', `${TAG_TS}1`] }, { id: 'y' }]) {
      await assert.rejects(() => decodeMessage({ key, kw, topic, raw }), IntegrityError);
    }
  });

  test('un événement ntfy « open » ou « keepalive » est ignoré, pas rejeté', async () => {
    assert.equal(await decodeMessage({ key, kw, topic, raw: { id: 'z', event: 'open', topic } }), null);
    assert.equal(await decodeMessage({ key, kw, topic, raw: { id: 'z', event: 'keepalive', topic } }), null);
  });
});

describe('protocol — anti-rejeu et ordre (R3, AC-07)', () => {
  test('un nonce déjà vu est signalé comme doublon', () => {
    const g = new ReplayGuard();
    const n = 'nonceAAAAAAAAAAA';
    assert.equal(g.check({ nonce: n, ts: 1000 }).duplicate, false);
    assert.equal(g.check({ nonce: n, ts: 1000 }).duplicate, true);
  });

  test('deux nonces distincts passent', () => {
    const g = new ReplayGuard();
    assert.equal(g.check({ nonce: 'a', ts: 1000 }).duplicate, false);
    assert.equal(g.check({ nonce: 'b', ts: 1000 }).duplicate, false);
  });

  test("un ts qui recule de plus de 60 s signale une rupture d'ordre", () => {
    const g = new ReplayGuard();
    g.check({ nonce: 'a', ts: 200_000 });
    assert.equal(g.check({ nonce: 'b', ts: 200_000 - 61_000 }).outOfOrder, true);
  });

  test('un léger désordre sous 60 s ne déclenche rien (horloges des pairs)', () => {
    const g = new ReplayGuard();
    g.check({ nonce: 'a', ts: 200_000 });
    assert.equal(g.check({ nonce: 'b', ts: 200_000 - 59_000 }).outOfOrder, false);
  });

  test('la mémoire des nonces est bornée', () => {
    const g = new ReplayGuard({ maxNonces: 4 });
    for (let i = 0; i < 10; i++) g.check({ nonce: `n${i}`, ts: 1000 + i });
    assert.equal(g.size, 4);
    assert.equal(g.check({ nonce: 'n9', ts: 1009 }).duplicate, true);
    assert.equal(g.check({ nonce: 'n0', ts: 1000 }).duplicate, false);
  });

  test('nonceOf lit le nonce du corps publié — la clé du dédoublonnage', async () => {
    const env = await encodeMessage({ key, kw, topic, from: 'alice', kind: 'text', text: 'ping' });
    assert.equal(nonceOf(env.body).length, 16);
  });
});
