/**
 * base64url sans remplissage — le seul encodage qui traverse sans dommage
 * un fragment d'URL, un en-tête ntfy et une valeur de tag.
 */

const B64U = /^[A-Za-z0-9_-]*$/;

/** @param {Buffer|Uint8Array|ArrayBuffer} bytes */
export function encodeB64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Accepte aussi l'alphabet standard et le remplissage : un pair peut être
 * moins strict que nous, mais nous ne devons jamais produire autre chose.
 * @param {string} s
 * @returns {Buffer}
 */
export function decodeB64u(s) {
  if (typeof s !== 'string') throw new TypeError('base64url : chaîne attendue');
  const normalised = s.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (!B64U.test(normalised)) throw new TypeError('base64url : caractère invalide');
  return Buffer.from(normalised, 'base64url');
}
