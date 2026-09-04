/**
 * Archive de session — le seul stockage durable du système (R8, D-04).
 * AC-12 nomme explicitement « export/replay » parmi les tests unitaires.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, generateTopic, deriveWriteKey } from '../lib/crypto.js';
import { encodeMessage } from '../lib/protocol.js';
import { buildExport, readExport, decodeExport, ArchiveError, EXPORT_VERSION } from '../lib/archive.js';
import { altererCorps } from './helpers/alterer.js';

const topic = generateTopic();
const key = generateKey();
const kw = await deriveWriteKey(key);

const brut = async (from, text, id, extra = {}) => {
  const env = await encodeMessage({ key, kw, topic, from, kind: 'text', text, ...extra });
  return { id, time: Math.floor(env.ts / 1000), event: 'message', topic, title: env.title, message: env.body, tags: env.tags };
};

describe('archive — construction d\'un export', () => {
  test('porte la version, le topic, le serveur et une date lisible', async () => {
    const a = buildExport({ topic, server: 'https://ntfy.test', messages: [await brut('alice', 'un', 'i1')], exportedAt: 1_780_000_000_000 });
    assert.equal(a.v, EXPORT_VERSION);
    assert.equal(a.topic, topic);
    assert.equal(a.server, 'https://ntfy.test');
    assert.equal(a.exportedAt, new Date(1_780_000_000_000).toISOString());
    assert.equal(a.messages.length, 1);
  });

  test("écarte les événements de service du bus, qui ne sont pas des messages", async () => {
    const a = buildExport({
      topic,
      server: 'x',
      messages: [{ id: 'o', event: 'open' }, await brut('alice', 'un', 'i1'), { id: 'k', event: 'keepalive' }, null],
    });
    assert.deepEqual(a.messages.map((m) => m.id), ['i1']);
  });

  test('conserve les messages tels quels : un export est une copie, pas une interprétation', async () => {
    const m = await brut('alice', 'un', 'i1');
    const a = buildExport({ topic, server: 'x', messages: [m] });
    assert.deepEqual(a.messages[0], m);
  });

  test('refuse un topic qui n\'en est pas un', () => {
    assert.throws(() => buildExport({ topic: 'salon', server: 'x', messages: [] }), ArchiveError);
  });
});

describe('archive — lecture défensive d\'un fichier', () => {
  test('accepte un export bien formé et en rend les parties', async () => {
    const a = buildExport({ topic, server: 'https://ntfy.test', messages: [await brut('alice', 'un', 'i1')] });
    const lu = readExport(a);
    assert.equal(lu.topic, topic);
    assert.equal(lu.server, 'https://ntfy.test');
    assert.equal(lu.messages.length, 1);
  });

  test('un serveur absent n\'empêche pas la relecture — la clé suffit', () => {
    assert.equal(readExport({ v: 1, topic, messages: [] }).server, null);
  });

  test('refuse ce qui n\'est pas un export, en disant pourquoi', () => {
    for (const [entree, motif] of [
      [null, /objet attendu/],
      ['une chaîne', /objet attendu/],
      [{ v: 42, topic, messages: [] }, /version inattendue/],
      [{ v: 1, topic: 'pas-un-topic', messages: [] }, /topic/],
      [{ v: 1, topic }, /liste de messages/],
    ]) {
      assert.throws(() => readExport(entree), motif, JSON.stringify(entree));
    }
  });

  test('ArchiveError porte le code de retour 2 du CLI', () => {
    assert.equal(new ArchiveError('x').exitCode, 2);
  });
});

describe('archive — relecture hors ligne', () => {
  test('rend les messages en clair, dans l\'ordre du fichier', async () => {
    const messages = [];
    for (let i = 1; i <= 5; i++) messages.push(await brut('alice', `ligne ${i}`, `i${i}`, { ts: 1_780_000_000_000 + i }));
    const relus = await decodeExport({ key, exportObj: buildExport({ topic, server: 'x', messages }) });

    assert.deepEqual(relus.map((m) => m.text), ['ligne 1', 'ligne 2', 'ligne 3', 'ligne 4', 'ligne 5']);
    assert.equal(relus.every((m) => m.verified === true), true);
    assert.equal(relus[0].from, 'alice');
  });

  test('une mauvaise clé ne rend rien de lisible', async () => {
    const a = buildExport({ topic, server: 'x', messages: [await brut('alice', 'secret', 'i1')] });
    const relus = await decodeExport({ key: generateKey(), exportObj: a });
    assert.equal(relus[0].integrity, 'invalid');
    assert.equal(relus[0].text, undefined, 'aucun texte ne doit être rendu');
  });

  test('un message atteint est signalé, les autres restent lisibles', async () => {
    const sain = await brut('alice', 'intact', 'i1');
    const abime = await brut('alice', 'abimé', 'i2');
    abime.message = altererCorps(abime.message);

    const relus = await decodeExport({ key, exportObj: buildExport({ topic, server: 'x', messages: [sain, abime] }) });
    assert.equal(relus[0].text, 'intact');
    assert.equal(relus[1].integrity, 'invalid');
    assert.ok(relus[1].reason);
  });

  test('les métadonnées privées se relisent aussi depuis une archive (AC-15)', async () => {
    const m = await brut('alice', 'discret', 'i1', { privateMeta: true });
    assert.equal(m.title, 'ac');
    const relus = await decodeExport({ key, exportObj: buildExport({ topic, server: 'x', messages: [m] }) });
    assert.equal(relus[0].from, 'alice');
    assert.equal(relus[0].text, 'discret');
  });

  test('un export vide se relit sans erreur', async () => {
    assert.deepEqual(await decodeExport({ key, exportObj: buildExport({ topic, server: 'x', messages: [] }) }), []);
  });
});
