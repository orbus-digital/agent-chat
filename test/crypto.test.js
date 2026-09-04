import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  generateKey, generateTopic, deriveWriteKey, buildAad,
  seal, open, IntegrityError, NONCE_LEN, TAG_LEN, TOPIC_RE,
} from '../lib/crypto.js';
import { decodeB64u, encodeB64u } from '../lib/base64url.js';

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

  test('generateTopic porte 192 bits d\'entropie et ne se répète pas', () => {
    const t = generateTopic();
    assert.equal(decodeB64u(t.slice(3)).length, 24);
    assert.equal(new Set(Array.from({ length: 200 }, generateTopic)).size, 200);
  });

  test('deriveWriteKey est déterministe, de 256 bits, et distincte de K', () => {
    const k = generateKey();
    const kw1 = deriveWriteKey(k);
    const kw2 = deriveWriteKey(k);
    assert.equal(kw1.length, 32);
    assert.deepEqual(kw1, kw2);
    assert.notDeepEqual(kw1, k);
  });

  test('deriveWriteKey sépare deux sessions', () => {
    assert.notDeepEqual(deriveWriteKey(generateKey()), deriveWriteKey(generateKey()));
  });

  test('deriveWriteKey exige exactement 32 octets', () => {
    assert.throws(() => deriveWriteKey(Buffer.alloc(16)), /256 bits/);
    assert.throws(() => deriveWriteKey('pas une clé'), /256 bits/);
  });
});

describe('crypto — AAD', () => {
  test('lie topic, auteur, kind et horodatage dans cet ordre', () => {
    assert.equal(String(buildAad('ac-x', 'alice', 'text', 1700000000000)), 'ac-x|alice|text|1700000000000');
  });
});

describe('crypto — scellement AES-256-GCM', () => {
  const ctx = { topic: generateTopic(), from: 'alice', kind: 'text', ts: 1788547637123 };

  test('un aller-retour rend le clair intact', () => {
    const k = generateKey();
    const clair = Buffer.from(JSON.stringify({ v: 1, text: 'ping' }));
    const body = seal({ key: k, ...ctx, plaintext: clair });
    assert.deepEqual(open({ key: k, ...ctx, body }), clair);
  });

  test('le corps est base64url(nonce||ct||tag) et rien d\'autre (spec §2.1)', () => {
    const k = generateKey();
    const clair = Buffer.from('douze octets');
    const body = seal({ key: k, ...ctx, plaintext: clair });
    assert.match(body, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeB64u(body).length, NONCE_LEN + clair.length + TAG_LEN);
  });

  test('deux scellements du même clair diffèrent (nonce aléatoire)', () => {
    const k = generateKey();
    const clair = Buffer.from('même texte');
    const a = seal({ key: k, ...ctx, plaintext: clair });
    const b = seal({ key: k, ...ctx, plaintext: clair });
    assert.notEqual(a, b);
    assert.notDeepEqual(decodeB64u(a).subarray(0, NONCE_LEN), decodeB64u(b).subarray(0, NONCE_LEN));
  });

  test('aucun octet du clair n\'apparaît dans le chiffré (AC-03)', () => {
    const k = generateKey();
    const body = seal({ key: k, ...ctx, plaintext: Buffer.from('ping') });
    assert.equal(decodeB64u(body).includes(Buffer.from('ping')), false);
    assert.equal(body.includes(encodeB64u(Buffer.from('ping'))), false);
  });

  test('une clé différente ne peut pas ouvrir (AC-05)', () => {
    const body = seal({ key: generateKey(), ...ctx, plaintext: Buffer.from('secret') });
    assert.throws(() => open({ key: generateKey(), ...ctx, body }), IntegrityError);
  });

  test('un chiffré altéré échoue et ne rend aucun clair partiel (AC-05)', () => {
    const k = generateKey();
    const clair = Buffer.from('un message assez long pour être tronqué');
    const brut = decodeB64u(seal({ key: k, ...ctx, plaintext: clair }));
    for (const i of [0, NONCE_LEN, NONCE_LEN + 5, brut.length - 1]) {
      const altere = Buffer.from(brut);
      altere[i] ^= 0x01;
      assert.throws(
        () => open({ key: k, ...ctx, body: encodeB64u(altere) }),
        IntegrityError,
        `octet ${i} altéré`,
      );
    }
  });

  test('une AAD différente échoue — le contexte est authentifié (AC-05)', () => {
    const k = generateKey();
    const body = seal({ key: k, ...ctx, plaintext: Buffer.from('ping') });
    for (const modif of [{ topic: generateTopic() }, { from: 'mallory' }, { kind: 'control' }, { ts: ctx.ts + 1 }]) {
      assert.throws(() => open({ key: k, ...ctx, ...modif, body }), IntegrityError, JSON.stringify(modif));
    }
  });

  test('un corps trop court est rejeté proprement', () => {
    const k = generateKey();
    assert.throws(() => open({ key: k, ...ctx, body: encodeB64u(randomBytes(NONCE_LEN + TAG_LEN - 1)) }), IntegrityError);
  });

  test("un corps qui n'est pas du base64url est rejeté comme défaut d'intégrité", () => {
    assert.throws(() => open({ key: generateKey(), ...ctx, body: 'pas du base64!!' }), IntegrityError);
  });

  test('IntegrityError porte le code de retour 5 du CLI', () => {
    assert.equal(new IntegrityError('x').exitCode, 5);
  });

  test('seal refuse une clé qui ne fait pas 256 bits', () => {
    assert.throws(() => seal({ key: Buffer.alloc(16), ...ctx, plaintext: Buffer.from('a') }), /256 bits/);
  });
});
