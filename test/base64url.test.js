import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeB64u, decodeB64u } from '../lib/base64url.js';

describe('base64url', () => {
  test('encode ne produit ni remplissage ni caractère non sûr pour une URL', () => {
    for (let n = 0; n < 40; n++) {
      const s = encodeB64u(randomBytes(n));
      assert.match(s, /^[A-Za-z0-9_-]*$/, `taille ${n} : ${s}`);
    }
  });

  test('32 octets donnent 43 caractères (contrat de la clé de session, AC-01)', () => {
    assert.equal(encodeB64u(Buffer.alloc(32)).length, 43);
  });

  test('24 octets donnent 32 caractères (contrat du suffixe de topic, AC-01)', () => {
    assert.equal(encodeB64u(Buffer.alloc(24)).length, 32);
  });

  test('aller-retour sur des octets aléatoires', () => {
    for (let n = 0; n < 32; n++) {
      const buf = randomBytes(n);
      assert.deepEqual(decodeB64u(encodeB64u(buf)), buf);
    }
  });

  test('décode aussi une entrée avec remplissage ou alphabet standard', () => {
    assert.deepEqual(decodeB64u('SGVsbG8='), Buffer.from('Hello'));
    assert.deepEqual(decodeB64u('-_8'), Buffer.from([0xfb, 0xff]));
  });

  test("rejette une entrée qui n'est pas du base64url", () => {
    assert.throws(() => decodeB64u('abc!def'), /base64url/);
    assert.throws(() => decodeB64u(42), /base64url/);
  });
});
