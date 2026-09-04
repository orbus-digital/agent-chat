/**
 * Noyau cryptographique du salon : AES-256-GCM pour le contenu, HKDF-SHA-256
 * pour la clé d'écriture. Rien d'autre ne doit chiffrer dans ce dépôt.
 *
 * Modèle de la spec §3 / architecture :
 *   K  (256 bits) — clé de session, ne quitte jamais le fragment d'URL.
 *   Kw = HKDF(K, "write") — clé de signature, dérivée donc jamais transportée.
 *   corps publié = base64url(nonce || ct || tag), AAD = topic|from|kind|ts.
 */

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { encodeB64u, decodeB64u } from './base64url.js';

export const KEY_LEN = 32;      // 256 bits
export const NONCE_LEN = 12;    // 96 bits, recommandation GCM
export const TAG_LEN = 16;      // 128 bits
export const TOPIC_PREFIX = 'ac-';
export const TOPIC_ENTROPY = 24; // 192 bits → 32 caractères base64url
export const TOPIC_RE = /^ac-[A-Za-z0-9_-]{32}$/;

const ALGO = 'aes-256-gcm';
const HKDF_INFO_WRITE = 'write';

/**
 * Échec de déchiffrement ou de forme du chiffré. Le CLI la traduit en code 5 ;
 * l'UI l'affiche comme « intégrité invalide » sans rien rendre de partiel.
 */
export class IntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'IntegrityError';
    this.code = 'INTEGRITY';
    this.exitCode = 5;
  }
}

/** Clé de session K, 256 bits. */
export function generateKey() {
  return randomBytes(KEY_LEN);
}

/** Nom de topic imprévisible : `ac-` + 192 bits en base64url. */
export function generateTopic() {
  return TOPIC_PREFIX + encodeB64u(randomBytes(TOPIC_ENTROPY));
}

function assertKey(key, label = 'clé') {
  if (!Buffer.isBuffer(key) && !ArrayBuffer.isView(key)) {
    throw new TypeError(`${label} : 256 bits attendus`);
  }
  if (key.length !== KEY_LEN) throw new TypeError(`${label} : 256 bits attendus`);
  return Buffer.from(key.buffer ?? key, key.byteOffset ?? 0, key.length);
}

/** Kw = HKDF-SHA-256(K, info="write"). Déterministe, jamais transportée. */
export function deriveWriteKey(key) {
  const k = assertKey(key, 'clé de session');
  return Buffer.from(hkdfSync('sha256', k, Buffer.alloc(0), HKDF_INFO_WRITE, KEY_LEN));
}

/**
 * Données additionnelles authentifiées : elles lient le chiffré à son contexte,
 * de sorte qu'un message ne puisse être rejoué sous un autre auteur, un autre
 * kind, un autre topic ou un autre horodatage.
 */
export function buildAad(topic, from, kind, ts) {
  return Buffer.from(`${topic}|${from}|${kind}|${ts}`, 'utf8');
}

/** @returns {string} corps à publier — base64url(nonce||ct||tag). */
export function seal({ key, topic, from, kind, ts, plaintext }) {
  const k = assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, k, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(buildAad(topic, from, kind, ts));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return encodeB64u(Buffer.concat([nonce, ct, cipher.getAuthTag()]));
}

/**
 * @returns {Buffer} le clair, ou lève IntegrityError.
 * Aucun clair partiel n'est retourné : `final()` valide le tag avant que nous
 * ne rendions quoi que ce soit.
 */
export function open({ key, topic, from, kind, ts, body }) {
  const k = assertKey(key);
  let raw;
  try {
    raw = decodeB64u(body);
  } catch (cause) {
    throw new IntegrityError('corps illisible : base64url attendu', { cause });
  }
  if (raw.length < NONCE_LEN + TAG_LEN) throw new IntegrityError('corps trop court');

  const nonce = raw.subarray(0, NONCE_LEN);
  const ct = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  try {
    const decipher = createDecipheriv(ALGO, k, nonce, { authTagLength: TAG_LEN });
    decipher.setAAD(buildAad(topic, from, kind, ts));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (cause) {
    throw new IntegrityError('déchiffrement invalide', { cause });
  }
}

/** Le nonce identifie le message pour la détection de rejeu (R3). */
export function nonceOf(body) {
  try {
    return encodeB64u(decodeB64u(body).subarray(0, NONCE_LEN));
  } catch (cause) {
    throw new IntegrityError('corps illisible : base64url attendu', { cause });
  }
}
