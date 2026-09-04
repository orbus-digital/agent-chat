/**
 * Altération déterministe d'un corps chiffré.
 *
 * Changer le *dernier caractère* d'un base64url ne change pas toujours les
 * octets décodés : les derniers bits d'un caractère peuvent ne rien coder.
 * Une altération faite ainsi passe la plupart du temps et échoue parfois — le
 * pire des tests. On retourne donc un **octet**, jamais un caractère.
 */

import { decodeB64u, encodeB64u } from '../../lib/bytes.js';

/** @param {string} corps base64url @param {number} position index d'octet (négatif = depuis la fin) */
export function altererCorps(corps, position = -1) {
  const octets = decodeB64u(corps);
  const i = position < 0 ? octets.length + position : position;
  octets[i] ^= 0x01;
  return encodeB64u(octets);
}
