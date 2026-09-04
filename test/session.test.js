import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKey, generateTopic } from '../lib/crypto.js';
import { encodeB64u } from '../lib/base64url.js';
import { saveSession, loadSession, sessionPath, sessionDir, listSessions, DEFAULT_TTL_H, MAX_TTL_H, normaliseTtl, isExpired } from '../lib/session.js';
import { UsageError, DEFAULT_NTFY_BASE } from '../lib/url.js';

let racine;
const topic = generateTopic();
const key = generateKey();

beforeEach(() => { racine = mkdtempSync(join(tmpdir(), 'agentchat-test-')); });
afterEach(() => rmSync(racine, { recursive: true, force: true }));

const base = () => ({ topic, server: DEFAULT_NTFY_BASE, k: encodeB64u(key), participant: 'alice', ro: false, ttlH: 24, createdAt: Date.now() });

describe('session — fichier local', () => {
  test('le fichier est écrit en 600 et le dossier en 700 (AC-01)', () => {
    saveSession(base(), { home: racine });
    assert.equal(statSync(sessionPath(topic, { home: racine })).mode & 0o777, 0o600);
    assert.equal(statSync(sessionDir({ home: racine })).mode & 0o777, 0o700);
  });

  test('le chemin suit ~/.agentchat/<topic>.json (spec §3)', () => {
    assert.equal(sessionPath(topic, { home: racine }), join(racine, '.agentchat', `${topic}.json`));
  });

  test('relit exactement ce qui a été écrit', () => {
    const s = base();
    saveSession(s, { home: racine });
    assert.deepEqual(loadSession(topic, { home: racine }), s);
  });

  test('une réécriture conserve le mode 600', () => {
    saveSession(base(), { home: racine });
    saveSession({ ...base(), lastId: 'abc' }, { home: racine });
    assert.equal(statSync(sessionPath(topic, { home: racine })).mode & 0o777, 0o600);
    assert.equal(loadSession(topic, { home: racine }).lastId, 'abc');
  });

  test('le fichier porte la clé, donc rien d\'autre ne doit la porter', () => {
    saveSession(base(), { home: racine });
    const brut = readFileSync(sessionPath(topic, { home: racine }), 'utf8');
    assert.ok(brut.includes(encodeB64u(key)));
    assert.equal(JSON.parse(brut).topic, topic);
  });

  test('une session inconnue est signalée comme mauvais usage, pas comme panne', () => {
    assert.throws(() => loadSession(topic, { home: racine }), UsageError);
  });

  test('un fichier corrompu est signalé clairement', () => {
    mkdirSync(join(racine, '.agentchat'), { recursive: true });
    writeFileSync(sessionPath(topic, { home: racine }), '{ pas du json');
    assert.throws(() => loadSession(topic, { home: racine }), /illisible/);
  });

  test('refuse d\'écrire une session sans topic valide', () => {
    assert.throws(() => saveSession({ ...base(), topic: 'nimporte' }, { home: racine }), UsageError);
  });

  test('listSessions énumère les sessions connues', () => {
    const t2 = generateTopic();
    saveSession(base(), { home: racine });
    saveSession({ ...base(), topic: t2 }, { home: racine });
    assert.deepEqual(listSessions({ home: racine }).sort(), [topic, t2].sort());
  });

  test('listSessions rend une liste vide si rien n\'existe encore', () => {
    assert.deepEqual(listSessions({ home: racine }), []);
  });
});

describe('session — durée de vie (R4)', () => {
  test('le défaut est 24 h et le maximum 168 h', () => {
    assert.equal(DEFAULT_TTL_H, 24);
    assert.equal(MAX_TTL_H, 168);
    assert.equal(normaliseTtl(undefined), 24);
    assert.equal(normaliseTtl('2'), 2);
    assert.equal(normaliseTtl(168), 168);
  });

  test('un TTL hors bornes est refusé plutôt que rogné en silence', () => {
    for (const mauvais of [0, -1, 169, 'deux', Number.NaN]) {
      assert.throws(() => normaliseTtl(mauvais), UsageError, String(mauvais));
    }
  });

  test('isExpired compare createdAt + ttlH à maintenant', () => {
    const h = 3600_000;
    assert.equal(isExpired({ createdAt: Date.now() - 1 * h, ttlH: 2 }), false);
    assert.equal(isExpired({ createdAt: Date.now() - 3 * h, ttlH: 2 }), true);
  });

  test('une session sans horodatage de création est considérée expirée — jamais l\'inverse', () => {
    assert.equal(isExpired({ ttlH: 2 }), true);
  });
});
