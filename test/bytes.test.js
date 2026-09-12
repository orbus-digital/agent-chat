/**
 * Couche octets du noyau isomorphe : elle ne connaît ni `Buffer` ni `node:*`,
 * puisque le même code doit s'exécuter dans un navigateur.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeB64u, decodeB64u, utf8, fromUtf8, concat, randomBytes } from '../lib/bytes.js';

describe('bytes — base64url', () => {
  test('encode ne produit ni remplissage ni caractère non sûr pour une URL', () => {
    for (let n = 0; n < 40; n++) {
      const s = encodeB64u(randomBytes(n));
      assert.match(s, /^[A-Za-z0-9_-]*$/, `taille ${n} : ${s}`);
    }
  });

  test('32 octets donnent 43 caractères (contrat de la clé de session, AC-01)', () => {
    assert.equal(encodeB64u(new Uint8Array(32)).length, 43);
  });

  test('24 octets donnent 32 caractères (contrat du suffixe de topic, AC-01)', () => {
    assert.equal(encodeB64u(new Uint8Array(24)).length, 32);
  });

  test('aller-retour sur des octets aléatoires', () => {
    for (let n = 0; n < 32; n++) {
      const octets = randomBytes(n);
      assert.deepEqual(decodeB64u(encodeB64u(octets)), octets);
    }
  });

  test('décode aussi une entrée avec remplissage ou alphabet standard', () => {
    assert.deepEqual(decodeB64u('SGVsbG8='), utf8('Hello'));
    assert.deepEqual(decodeB64u('-_8'), new Uint8Array([0xfb, 0xff]));
  });

  test('rend bien un Uint8Array, jamais un Buffer déguisé', () => {
    const r = decodeB64u('SGVsbG8');
    assert.equal(r.constructor, Uint8Array);
  });

  test("rejette une entrée qui n'est pas du base64url", () => {
    assert.throws(() => decodeB64u('abc!def'), /base64url/);
    assert.throws(() => decodeB64u(42), /base64url/);
  });

  test('encode accepte un ArrayBuffer comme un Uint8Array', () => {
    const u = randomBytes(9);
    assert.equal(encodeB64u(u.buffer), encodeB64u(u));
  });
});

describe('bytes — texte', () => {
  test('aller-retour utf8 sur des caractères hors ASCII', () => {
    for (const s of ['', 'a', 'clé de session', 'ça déchiffre — ok', '👀 observateur']) {
      assert.equal(fromUtf8(utf8(s)), s);
    }
  });

  test('utf8 compte les octets, pas les caractères', () => {
    assert.equal(utf8('é').length, 2);
    assert.equal(utf8('👀').length, 4);
  });
});

describe('bytes — assemblage', () => {
  test('concat met bout à bout dans l\'ordre', () => {
    assert.deepEqual(concat(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])), new Uint8Array([1, 2, 3]));
  });

  test('concat sans argument rend un tableau vide', () => {
    assert.deepEqual(concat(), new Uint8Array(0));
  });
});

describe('bytes — aléa', () => {
  test('randomBytes rend la longueur demandée et ne se répète pas', () => {
    assert.equal(randomBytes(32).length, 32);
    assert.notDeepEqual(randomBytes(32), randomBytes(32));
  });
});
