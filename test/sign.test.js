import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, deriveWriteKey } from '../lib/crypto.js';
import { signBody, verifyBody, SIG_LEN } from '../lib/sign.js';

const kw = deriveWriteKey(generateKey());
const autreKw = deriveWriteKey(generateKey());

describe('sign — HMAC-SHA-256(Kw, corps)', () => {
  test('la signature est du base64url de 43 caractères', () => {
    const sig = signBody(kw, 'Q29ycHM');
    assert.match(sig, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(sig.length, SIG_LEN);
  });

  test('elle est déterministe pour un même couple (Kw, corps)', () => {
    assert.equal(signBody(kw, 'Q29ycHM'), signBody(kw, 'Q29ycHM'));
  });

  test('elle change avec le corps', () => {
    assert.notEqual(signBody(kw, 'Q29ycHM'), signBody(kw, 'Q29ycHN'));
  });

  test('elle change avec la clé — une session ne signe pas pour une autre', () => {
    assert.notEqual(signBody(kw, 'Q29ycHM'), signBody(autreKw, 'Q29ycHM'));
  });

  test('verifyBody accepte la signature qu\'elle vient de produire', () => {
    assert.equal(verifyBody(kw, 'Q29ycHM', signBody(kw, 'Q29ycHM')), true);
  });

  test('verifyBody rejette une signature altérée (AC-04)', () => {
    const sig = signBody(kw, 'Q29ycHM');
    const altere = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.equal(verifyBody(kw, 'Q29ycHM', altere), false);
  });

  test('verifyBody rejette la signature d\'un autre corps (rejeu de signature)', () => {
    assert.equal(verifyBody(kw, 'Q29ycHM', signBody(kw, 'YXV0cmU')), false);
  });

  test('verifyBody rejette la signature d\'une autre session', () => {
    assert.equal(verifyBody(kw, 'Q29ycHM', signBody(autreKw, 'Q29ycHM')), false);
  });

  test('verifyBody rend false — jamais une exception — sur une entrée absente ou difforme', () => {
    for (const mauvais of [undefined, null, '', 'trop-court', 'a'.repeat(43), 42, '!'.repeat(43)]) {
      assert.equal(verifyBody(kw, 'Q29ycHM', mauvais), false, String(mauvais));
    }
  });

  test('verifyBody rend false si la clé est absente (observateur sans Kw)', () => {
    assert.equal(verifyBody(null, 'Q29ycHM', signBody(kw, 'Q29ycHM')), false);
  });

  test('signBody exige une clé de 256 bits', () => {
    assert.throws(() => signBody(Buffer.alloc(8), 'Q29ycHM'), /256 bits/);
  });

  test('la comparaison ne fuit pas par sa durée : longueurs inégales gérées sans lever', () => {
    assert.equal(verifyBody(kw, 'Q29ycHM', signBody(kw, 'Q29ycHM').slice(0, 20)), false);
  });
});
