import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, generateTopic } from '../lib/crypto.js';
import { encodeB64u } from '../lib/base64url.js';
import { buildSessionUrl, parseSessionUrl, DEFAULT_UI_BASE, DEFAULT_NTFY_BASE, UsageError } from '../lib/url.js';

const topic = generateTopic();
const key = generateKey();

describe('url — construction', () => {
  test("l'URL suit exactement la forme attendue par AC-01", () => {
    const url = buildSessionUrl({ topic, key });
    assert.match(url, /^https:\/\/\S+\/#t=ac-[A-Za-z0-9_-]{32}&k=[A-Za-z0-9_-]{43}$/);
    assert.ok(url.startsWith(DEFAULT_UI_BASE));
  });

  test('la clé et le topic ne sont jamais hors du fragment (R1)', () => {
    const url = buildSessionUrl({ topic, key });
    const avantFragment = url.slice(0, url.indexOf('#'));
    assert.equal(avantFragment.includes(encodeB64u(key)), false);
    assert.equal(avantFragment.includes(topic), false);
  });

  test('le mode observateur ajoute ro=1', () => {
    assert.match(buildSessionUrl({ topic, key, ro: true }), /&ro=1$/);
    assert.equal(buildSessionUrl({ topic, key, ro: false }).includes('ro='), false);
  });

  test("un serveur ntfy non standard est porté par le fragment, encodé", () => {
    const url = buildSessionUrl({ topic, key, server: 'https://ntfy.exemple.test' });
    assert.match(url, /&s=[A-Za-z0-9_-]+$/);
    assert.equal(parseSessionUrl(url).server, 'https://ntfy.exemple.test');
  });

  test('le serveur par défaut n\'est pas écrit — AC-01 attend une URL à deux paramètres', () => {
    assert.equal(buildSessionUrl({ topic, key, server: DEFAULT_NTFY_BASE }).includes('&s='), false);
  });

  test('une base UI personnalisée est respectée, avec ou sans barre finale', () => {
    for (const base of ['https://chat.exemple.test', 'https://chat.exemple.test/']) {
      assert.ok(buildSessionUrl({ topic, key, uiBase: base }).startsWith('https://chat.exemple.test/#t='));
    }
  });

  test('refuse un topic ou une clé difformes', () => {
    assert.throws(() => buildSessionUrl({ topic: 'nimporte', key }), UsageError);
    assert.throws(() => buildSessionUrl({ topic, key: Buffer.alloc(16) }), UsageError);
  });
});

describe('url — lecture', () => {
  test('relit ce qu\'elle a écrit', () => {
    const url = buildSessionUrl({ topic, key });
    const s = parseSessionUrl(url);
    assert.equal(s.topic, topic);
    assert.deepEqual(s.key, key);
    assert.equal(s.ro, false);
    assert.equal(s.server, DEFAULT_NTFY_BASE);
  });

  test('lit le mode observateur', () => {
    assert.equal(parseSessionUrl(buildSessionUrl({ topic, key, ro: true })).ro, true);
  });

  test('accepte un fragment nu, sans origine (usage CLI)', () => {
    const s = parseSessionUrl(`#t=${topic}&k=${encodeB64u(key)}`);
    assert.equal(s.topic, topic);
    assert.deepEqual(s.key, key);
  });

  test('signale une clé absente plutôt que de deviner (AC-06)', () => {
    assert.throws(() => parseSessionUrl(`https://x.test/#t=${topic}`), /clé absente/);
  });

  test('refuse un topic absent ou difforme', () => {
    assert.throws(() => parseSessionUrl(`https://x.test/#k=${encodeB64u(key)}`), /topic/);
    assert.throws(() => parseSessionUrl(`https://x.test/#t=zzz&k=${encodeB64u(key)}`), /topic/);
  });

  test('refuse une clé qui ne fait pas 256 bits', () => {
    assert.throws(() => parseSessionUrl(`https://x.test/#t=${topic}&k=${encodeB64u(Buffer.alloc(16))}`), /256 bits/);
  });

  test('refuse une entrée sans fragment', () => {
    assert.throws(() => parseSessionUrl('https://x.test/'), UsageError);
    assert.throws(() => parseSessionUrl(''), UsageError);
    assert.throws(() => parseSessionUrl(undefined), UsageError);
  });

  test('UsageError porte le code de retour 2 du CLI', () => {
    assert.equal(new UsageError('x').exitCode, 2);
  });

  test("conserve l'origine pour que l'UI sache d'où elle est servie", () => {
    assert.equal(parseSessionUrl(buildSessionUrl({ topic, key, uiBase: 'https://chat.exemple.test' })).uiBase, 'https://chat.exemple.test/');
  });
});
