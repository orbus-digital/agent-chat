import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKey, generateTopic, deriveWriteKey, buildAad,
  seal, open, IntegrityError, NONCE_LEN, TAG_LEN, TOPIC_RE,
} from '../lib/crypto.js';
import { decodeB64u, encodeB64u, utf8, fromUtf8, randomBytes } from '../lib/bytes.js';

/** La suite d'octets `petit` apparaît-elle telle quelle dans `grand` ? */
function contient(grand, petit) {
  for (let i = 0; i + petit.length <= grand.length; i++) {
    if (petit.every((o, j) => grand[i + j] === o)) return true;
  }
  return false;
}

describe('crypto — clés et topics', () => {
  test('generateKey donne 256 bits, donc 43 caractères une fois encodée (AC-01)', () => {
    const k = generateKey();
    assert.equal(k.length, 32);
    assert.equal(encodeB64u(k).length, 43);
  });

  test('generateKey ne se répète pas', () => {
    const vus = new Set(Array.from({ length: 200 }, () => encodeB64u(generateKey())));
    assert.equal(vus.size, 200);
  });

  test('generateTopic donne « ac- » suivi de 32 caractères base64url (AC-01)', () => {
    for (let i = 0; i < 50; i++) {
      const t = generateTopic();
      assert.match(t, TOPIC_RE);
      assert.equal(t.length, 3 + 32);
    }
  });

  test("generateTopic porte 192 bits d'entropie et ne se répète pas", () => {
    assert.equal(decodeB64u(generateTopic().slice(3)).length, 24);
    assert.equal(new Set(Array.from({ length: 200 }, generateTopic)).size, 200);
  });

  test('deriveWriteKey est déterministe, de 256 bits, et distincte de K', async () => {
    const k = generateKey();
    const kw1 = await deriveWriteKey(k);
    const kw2 = await deriveWriteKey(k);
    assert.equal(kw1.length, 32);
    assert.deepEqual(kw1, kw2);
    assert.notDeepEqual(kw1, k);
  });

  test('deriveWriteKey sépare deux sessions', async () => {
    assert.notDeepEqual(await deriveWriteKey(generateKey()), await deriveWriteKey(generateKey()));
  });

  test('deriveWriteKey exige exactement 32 octets', async () => {
    await assert.rejects(() => deriveWriteKey(new Uint8Array(16)), /256 bits/);
    await assert.rejects(() => deriveWriteKey('pas une clé'), /256 bits/);
  });
});

describe('crypto — AAD', () => {
  test('lie topic, auteur, kind et horodatage dans cet ordre', () => {
    assert.equal(fromUtf8(buildAad('ac-x', 'alice', 'text', 1700000000000)), 'ac-x|alice|text|1700000000000');
  });
});

describe('crypto — scellement AES-256-GCM', () => {
  const ctx = { topic: generateTopic(), from: 'alice', kind: 'text', ts: 1788547637123 };

  test('un aller-retour rend le clair intact', async () => {
    const k = generateKey();
    const clair = utf8(JSON.stringify({ v: 1, text: 'ping' }));
    const body = await seal({ key: k, ...ctx, plaintext: clair });
    assert.deepEqual(await open({ key: k, ...ctx, body }), clair);
  });

  test("le corps est base64url(nonce||ct||tag) et rien d'autre (spec §2.1)", async () => {
    const k = generateKey();
    const clair = utf8('douze octets');
    const body = await seal({ key: k, ...ctx, plaintext: clair });
    assert.match(body, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeB64u(body).length, NONCE_LEN + clair.length + TAG_LEN);
  });

  test('deux scellements du même clair diffèrent (nonce aléatoire)', async () => {
    const k = generateKey();
    const a = await seal({ key: k, ...ctx, plaintext: utf8('même texte') });
    const b = await seal({ key: k, ...ctx, plaintext: utf8('même texte') });
    assert.notEqual(a, b);
    assert.notDeepEqual(decodeB64u(a).subarray(0, NONCE_LEN), decodeB64u(b).subarray(0, NONCE_LEN));
  });

  test("aucun octet du clair n'apparaît dans le chiffré (AC-03)", async () => {
    const k = generateKey();
    const body = await seal({ key: k, ...ctx, plaintext: utf8('ping') });
    assert.equal(contient(decodeB64u(body), utf8('ping')), false);
    assert.equal(body.includes(encodeB64u(utf8('ping'))), false);
  });

  test('une clé différente ne peut pas ouvrir (AC-05)', async () => {
    const body = await seal({ key: generateKey(), ...ctx, plaintext: utf8('secret') });
    await assert.rejects(() => open({ key: generateKey(), ...ctx, body }), IntegrityError);
  });

  test("un chiffré altéré échoue et ne rend aucun clair partiel (AC-05)", async () => {
    const k = generateKey();
    const brut = decodeB64u(await seal({ key: k, ...ctx, plaintext: utf8('un message assez long pour être tronqué') }));
    for (const i of [0, NONCE_LEN, NONCE_LEN + 5, brut.length - 1]) {
      const altere = Uint8Array.from(brut);
      altere[i] ^= 0x01;
      await assert.rejects(() => open({ key: k, ...ctx, body: encodeB64u(altere) }), IntegrityError, `octet ${i} altéré`);
    }
  });

  test('une AAD différente échoue — le contexte est authentifié (AC-05)', async () => {
    const k = generateKey();
    const body = await seal({ key: k, ...ctx, plaintext: utf8('ping') });
    for (const modif of [{ topic: generateTopic() }, { from: 'mallory' }, { kind: 'control' }, { ts: ctx.ts + 1 }]) {
      await assert.rejects(() => open({ key: k, ...ctx, ...modif, body }), IntegrityError, JSON.stringify(modif));
    }
  });

  test('un corps trop court est rejeté proprement', async () => {
    await assert.rejects(
      () => open({ key: generateKey(), ...ctx, body: encodeB64u(randomBytes(NONCE_LEN + TAG_LEN - 1)) }),
      IntegrityError,
    );
  });

  test("un corps qui n'est pas du base64url est rejeté comme défaut d'intégrité", async () => {
    await assert.rejects(() => open({ key: generateKey(), ...ctx, body: 'pas du base64!!' }), IntegrityError);
  });

  test('IntegrityError porte le code de retour 5 du CLI', () => {
    assert.equal(new IntegrityError('x').exitCode, 5);
  });

  test('seal refuse une clé qui ne fait pas 256 bits', async () => {
    await assert.rejects(() => seal({ key: new Uint8Array(16), ...ctx, plaintext: utf8('a') }), /256 bits/);
  });

  test('un texte peut être scellé directement, sans encodage préalable', async () => {
    const k = generateKey();
    const body = await seal({ key: k, ...ctx, plaintext: 'ping' });
    assert.equal(fromUtf8(await open({ key: k, ...ctx, body })), 'ping');
  });
});
