import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, deriveWriteKey } from '../lib/crypto.js';
import { signBody, verifyBody, SIG_LEN } from '../lib/sign.js';

const kw = await deriveWriteKey(generateKey());
const autreKw = await deriveWriteKey(generateKey());

describe('sign — HMAC-SHA-256(Kw, corps)', () => {
  test('la signature est du base64url de 43 caractères', async () => {
    const sig = await signBody(kw, 'Q29ycHM');
    assert.match(sig, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(sig.length, SIG_LEN);
  });

  test('elle est déterministe pour un même couple (Kw, corps)', async () => {
    assert.equal(await signBody(kw, 'Q29ycHM'), await signBody(kw, 'Q29ycHM'));
  });

  test('elle change avec le corps', async () => {
    assert.notEqual(await signBody(kw, 'Q29ycHM'), await signBody(kw, 'Q29ycHN'));
  });

  test('elle change avec la clé — une session ne signe pas pour une autre', async () => {
    assert.notEqual(await signBody(kw, 'Q29ycHM'), await signBody(autreKw, 'Q29ycHM'));
  });

  test('verifyBody accepte la signature qu\'elle vient de produire', async () => {
    assert.equal(await verifyBody(kw, 'Q29ycHM', await signBody(kw, 'Q29ycHM')), true);
  });

  test('verifyBody rejette une signature altérée (AC-04)', async () => {
    const sig = await signBody(kw, 'Q29ycHM');
    const altere = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.equal(await verifyBody(kw, 'Q29ycHM', altere), false);
  });

  test('verifyBody rejette la signature d\'un autre corps (rejeu de signature)', async () => {
    assert.equal(await verifyBody(kw, 'Q29ycHM', await signBody(kw, 'YXV0cmU')), false);
  });

  test('verifyBody rejette la signature d\'une autre session', async () => {
    assert.equal(await verifyBody(kw, 'Q29ycHM', await signBody(autreKw, 'Q29ycHM')), false);
  });

  test('verifyBody rend false — jamais une exception — sur une entrée absente ou difforme', async () => {
    for (const mauvais of [undefined, null, '', 'trop-court', 'a'.repeat(43), 42, '!'.repeat(43)]) {
      assert.equal(await verifyBody(kw, 'Q29ycHM', mauvais), false, String(mauvais));
    }
  });

  test('verifyBody rend false si la clé est absente (observateur sans Kw)', async () => {
    assert.equal(await verifyBody(null, 'Q29ycHM', await signBody(kw, 'Q29ycHM')), false);
  });

  test('signBody exige une clé de 256 bits', async () => {
    await assert.rejects(() => signBody(new Uint8Array(8), 'Q29ycHM'), /256 bits/);
  });

  test('la comparaison ne fuit pas par sa durée : longueurs inégales gérées sans lever', async () => {
    assert.equal(await verifyBody(kw, 'Q29ycHM', (await signBody(kw, 'Q29ycHM')).slice(0, 20)), false);
  });
});
