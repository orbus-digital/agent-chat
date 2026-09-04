/**
 * Signature d'écriture. Kw = HKDF(K, "write") : tout porteur de K peut la
 * dériver, donc c'est une preuve d'appartenance à la session, pas une preuve
 * d'identité (spec R7 ; Ed25519 par participant en phase 2).
 *
 * ntfy.sh ne réexpédie aucun en-tête inconnu : la signature voyage dans un tag
 * (`sig:<b64u>`), le corps reste exactement base64url(nonce||ct||tag). Voir ADR-001.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { encodeB64u, decodeB64u } from './base64url.js';
import { KEY_LEN } from './crypto.js';

/** Longueur d'une signature encodée : 32 octets → 43 caractères base64url. */
export const SIG_LEN = 43;

function assertWriteKey(kw) {
  if (!Buffer.isBuffer(kw) && !ArrayBuffer.isView(kw)) throw new TypeError("clé d'écriture : 256 bits attendus");
  if (kw.length !== KEY_LEN) throw new TypeError("clé d'écriture : 256 bits attendus");
  return kw;
}

/** @returns {string} HMAC-SHA-256(Kw, corps) en base64url. */
export function signBody(kw, body) {
  assertWriteKey(kw);
  return encodeB64u(createHmac('sha256', kw).update(String(body), 'utf8').digest());
}

/**
 * Ne lève jamais : un message non vérifiable est un message *affichable comme
 * non vérifié*, pas une panne. Le refus de rendre du texte authentifié se
 * décide en amont, dans le protocole.
 * @returns {boolean}
 */
export function verifyBody(kw, body, sig) {
  if (typeof sig !== 'string' || sig.length !== SIG_LEN) return false;
  let attendu;
  let fourni;
  try {
    attendu = decodeB64u(signBody(kw, body));
    fourni = decodeB64u(sig);
  } catch {
    return false;
  }
  if (attendu.length !== fourni.length) return false;
  return timingSafeEqual(attendu, fourni);
}
