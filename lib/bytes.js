/**
 * Couche octets du noyau. Volontairement dépourvue de `Buffer` et de tout
 * import `node:*` : ce fichier est chargé tel quel par le navigateur depuis
 * GitHub Pages **et** par le CLI sous Node 22. Une seule implémentation du
 * protocole, donc aucune divergence possible entre l'interface et le CLI.
 *
 * base64url sans remplissage est le seul encodage qui traverse sans dommage
 * un fragment d'URL, un en-tête ntfy et une valeur de tag.
 */

const B64U = /^[A-Za-z0-9_-]*$/;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes */
function asBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('octets attendus');
}

/** @returns {string} base64url sans remplissage */
export function encodeB64u(bytes) {
  const u = asBytes(bytes);
  let binaire = '';
  // Par tranches : `String.fromCharCode(...u)` dépasse la pile sur un gros message.
  for (let i = 0; i < u.length; i += 0x8000) {
    binaire += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  }
  return btoa(binaire).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Accepte aussi l'alphabet standard et le remplissage : un pair peut être
 * moins strict que nous, mais nous ne devons jamais produire autre chose.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function decodeB64u(s) {
  if (typeof s !== 'string') throw new TypeError('base64url : chaîne attendue');
  const normalise = s.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (!B64U.test(normalise)) throw new TypeError('base64url : caractère invalide');
  const binaire = atob(normalise.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) out[i] = binaire.charCodeAt(i);
  return out;
}

/** @param {string} s @returns {Uint8Array} */
export function utf8(s) {
  return ENC.encode(String(s));
}

/** @param {Uint8Array} bytes @returns {string} */
export function fromUtf8(bytes) {
  return DEC.decode(asBytes(bytes));
}

/** @param {...Uint8Array} parts @returns {Uint8Array} */
export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

/** Aléa cryptographique — WebCrypto, présent nativement des deux côtés. */
export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Nombre d'octets d'une chaîne une fois encodée en UTF-8. */
export function byteLength(s) {
  return utf8(s).length;
}

export { asBytes };
