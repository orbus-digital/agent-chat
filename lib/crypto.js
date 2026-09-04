/**
 * Noyau cryptographique du salon : AES-256-GCM pour le contenu, HKDF-SHA-256
 * pour la clé d'écriture. Rien d'autre ne doit chiffrer dans ce dépôt.
 *
 * Écrit en **WebCrypto pur** — donc asynchrone — parce que le même fichier est
 * chargé par le navigateur depuis GitHub Pages et par le CLI sous Node 22.
 * Deux implémentations auraient divergé un jour, et la divergence d'un
 * protocole de chiffrement ne casse pas un test : elle rend un message
 * illisible, ou faussement authentifié.
 *
 * Modèle de la spec §3 / architecture :
 *   K  (256 bits) — clé de session, ne quitte jamais le fragment d'URL.
 *   Kw = HKDF(K, "write") — clé de signature, dérivée donc jamais transportée.
 *   corps publié = base64url(nonce || ct || tag), AAD = topic|from|kind|ts.
 */

import { encodeB64u, decodeB64u, utf8, randomBytes, asBytes } from './bytes.js';

export const KEY_LEN = 32;      // 256 bits
export const NONCE_LEN = 12;    // 96 bits, recommandation GCM
export const TAG_LEN = 16;      // 128 bits
export const TOPIC_PREFIX = 'ac-';
export const TOPIC_ENTROPY = 24; // 192 bits → 32 caractères base64url
export const TOPIC_RE = /^ac-[A-Za-z0-9_-]{32}$/;

const HKDF_INFO_WRITE = 'write';
const subtle = () => globalThis.crypto.subtle;

/**
 * Échec de déchiffrement ou de forme du chiffré. Le CLI la traduit en code 5 ;
 * l'interface l'affiche comme « intégrité invalide » sans rien rendre de partiel.
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
  if (!ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer)) throw new TypeError(`${label} : 256 bits attendus`);
  const octets = asBytes(key);
  if (octets.length !== KEY_LEN) throw new TypeError(`${label} : 256 bits attendus`);
  return octets;
}

/** Kw = HKDF-SHA-256(K, info="write"). Déterministe, jamais transportée. */
export async function deriveWriteKey(key) {
  const k = assertKey(key, 'clé de session');
  const materiel = await subtle().importKey('raw', k, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO_WRITE) },
    materiel,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Données additionnelles authentifiées : elles lient le chiffré à son contexte,
 * de sorte qu'un message ne puisse être rejoué sous un autre auteur, un autre
 * kind, un autre topic ou un autre horodatage.
 *
 * `from` et `kind` sont ici ceux **réellement publiés** sur le bus. En mode
 * `--private-meta` ce sont les constantes (`ac`, `m`) : l'AAD reste donc
 * vérifiable par un destinataire qui n'a pas encore ouvert le message.
 */
export function buildAad(topic, from, kind, ts) {
  return utf8(`${topic}|${from}|${kind}|${ts}`);
}

async function aesKey(raw, usages) {
  return subtle().importKey('raw', assertKey(raw), { name: 'AES-GCM' }, false, usages);
}

/** @returns {Promise<string>} corps à publier — base64url(nonce||ct||tag). */
export async function seal({ key, topic, from, kind, ts, plaintext }) {
  const k = await aesKey(key, ['encrypt']);
  const nonce = randomBytes(NONCE_LEN);
  const scelle = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: buildAad(topic, from, kind, ts), tagLength: TAG_LEN * 8 },
    k,
    asBytes(typeof plaintext === 'string' ? utf8(plaintext) : plaintext),
  );
  // WebCrypto rend déjà ct||tag : la concaténation attendue est donc nonce||ct||tag.
  const out = new Uint8Array(NONCE_LEN + scelle.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(scelle), NONCE_LEN);
  return encodeB64u(out);
}

/**
 * @returns {Promise<Uint8Array>} le clair, ou lève IntegrityError.
 * Aucun clair partiel n'est rendu : WebCrypto valide le tag avant de restituer
 * quoi que ce soit.
 */
export async function open({ key, topic, from, kind, ts, body }) {
  const k = await aesKey(key, ['decrypt']);
  let brut;
  try {
    brut = decodeB64u(body);
  } catch (cause) {
    throw new IntegrityError('corps illisible : base64url attendu', { cause });
  }
  if (brut.length < NONCE_LEN + TAG_LEN) throw new IntegrityError('corps trop court');

  try {
    const clair = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: brut.subarray(0, NONCE_LEN),
        additionalData: buildAad(topic, from, kind, ts),
        tagLength: TAG_LEN * 8,
      },
      k,
      brut.subarray(NONCE_LEN),
    );
    return new Uint8Array(clair);
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
