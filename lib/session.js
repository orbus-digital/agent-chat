/**
 * Fichier de session local : `~/.agentchat/<topic>.json`, en 600, parce qu'il
 * porte K en clair. C'est le seul endroit du système où la clé est au repos.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOPIC_RE } from './crypto.js';
import { UsageError } from './url.js';

export const DIR_NAME = '.agentchat';
/** R4 : 24 h par défaut, 168 h au plus. */
export const DEFAULT_TTL_H = 24;
export const MAX_TTL_H = 168;

export function sessionDir({ home = homedir() } = {}) {
  return join(home, DIR_NAME);
}

export function sessionPath(topic, opts = {}) {
  return join(sessionDir(opts), `${topic}.json`);
}

/** @param {{topic:string, server:string, k:string, participant:string, ro:boolean, lastId?:string, ttlH:number, createdAt:number}} session */
export function saveSession(session, opts = {}) {
  if (!TOPIC_RE.test(session?.topic ?? '')) throw new UsageError(`topic invalide : ${session?.topic}`);
  const dir = sessionDir(opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const chemin = sessionPath(session.topic, opts);
  writeFileSync(chemin, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync n'applique `mode` qu'à la création : une réécriture garderait
  // les droits d'un fichier préexistant plus permissif.
  chmodSync(chemin, 0o600);
  return chemin;
}

export function loadSession(topic, opts = {}) {
  const chemin = sessionPath(topic, opts);
  if (!existsSync(chemin)) {
    throw new UsageError(`session inconnue : ${topic} — rejoignez-la d'abord avec « agentchat join <url> --as <nom> »`);
  }
  try {
    return JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (cause) {
    throw new UsageError(`fichier de session illisible : ${chemin}`, { cause });
  }
}

export function listSessions(opts = {}) {
  const dir = sessionDir(opts);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((t) => TOPIC_RE.test(t));
}

/** @returns {number} heures, dans les bornes de R4 ; lève plutôt que de rogner. */
export function normaliseTtl(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return DEFAULT_TTL_H;
  const h = Number(valeur);
  if (!Number.isFinite(h) || !Number.isInteger(h) || h < 1 || h > MAX_TTL_H) {
    throw new UsageError(`--ttl : entier entre 1 et ${MAX_TTL_H} heures (reçu « ${valeur} »)`);
  }
  return h;
}

/** Une session dont on ignore la date de création est traitée comme expirée. */
export function isExpired({ createdAt, ttlH = DEFAULT_TTL_H } = {}, maintenant = Date.now()) {
  if (!Number.isFinite(createdAt)) return true;
  return maintenant >= createdAt + ttlH * 3600_000;
}
