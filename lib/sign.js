/**
 * Signature d'écriture. Kw = HKDF(K, "write") : tout porteur de K peut la
 * dériver, donc c'est une preuve d'appartenance à la session, pas une preuve
 * d'identité (spec R7 ; Ed25519 par participant en phase 2).
 *
 * ntfy.sh ne réexpédie aucun en-tête inconnu : la signature voyage dans un tag
 * (`sig:<b64u>`), le corps reste exactement base64url(nonce||ct||tag). Voir ADR-001.
 *
 * WebCrypto pur, donc asynchrone : `subtle.verify` compare en temps constant,
 * ce qui nous évite d'écrire nous-mêmes une comparaison qui ne fuit pas.
 */

import { encodeB64u, decodeB64u, utf8, asBytes } from './bytes.js';
import { KEY_LEN } from './crypto.js';

/** Longueur d'une signature encodée : 32 octets → 43 caractères base64url. */
export const SIG_LEN = 43;

const subtle = () => globalThis.crypto.subtle;

async function hmacKey(kw, usages) {
  if (!ArrayBuffer.isView(kw) && !(kw instanceof ArrayBuffer)) throw new TypeError("clé d'écriture : 256 bits attendus");
  const octets = asBytes(kw);
  if (octets.length !== KEY_LEN) throw new TypeError("clé d'écriture : 256 bits attendus");
  return subtle().importKey('raw', octets, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/** @returns {Promise<string>} HMAC-SHA-256(Kw, corps) en base64url. */
export async function signBody(kw, body) {
  const k = await hmacKey(kw, ['sign']);
  return encodeB64u(await subtle().sign('HMAC', k, utf8(String(body))));
}

/**
 * Ne rejette jamais : un message non vérifiable est un message *affichable
 * comme non vérifié*, pas une panne. Le refus de rendre du texte authentifié
 * se décide en amont, dans le protocole.
 * @returns {Promise<boolean>}
 */
export async function verifyBody(kw, body, sig) {
  if (typeof sig !== 'string' || sig.length !== SIG_LEN) return false;
  try {
    const k = await hmacKey(kw, ['verify']);
    return await subtle().verify('HMAC', k, decodeB64u(sig), utf8(String(body)));
  } catch {
    return false;
  }
}
