/**
 * URL capacitaire : tout le pouvoir de lire est dans le fragment, et un
 * fragment n'est jamais envoyé au serveur par un navigateur (R1).
 *
 *   https://<pages>/#t=<topic>&k=<K base64url>[&ro=1][&s=<serveur ntfy base64url>]
 */

import { encodeB64u, decodeB64u, utf8, fromUtf8 } from './bytes.js';
import { KEY_LEN, TOPIC_RE } from './crypto.js';
import { normaliseServeur, UsageError, DEFAULT_NTFY_BASE } from './serveur.js';

export const DEFAULT_UI_BASE = 'https://orbus-digital.github.io/agent-chat/';

// La garde de schéma et l'erreur d'usage vivent dans `serveur.js` — c'est lui
// qui décide quel bus est joignable. On les ré-expose ici parce que c'est d'ici
// que le reste du programme les importe depuis l'origine.
export { UsageError, DEFAULT_NTFY_BASE };

const withSlash = (base) => (base.endsWith('/') ? base : `${base}/`);
const stripSlash = (base) => base.replace(/\/+$/, '');

export function buildSessionUrl({ topic, key, ro = false, server = DEFAULT_NTFY_BASE, uiBase = DEFAULT_UI_BASE, allowInsecure = false }) {
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new UsageError(`topic invalide : ${topic}`);
  if (!ArrayBuffer.isView(key) || key.length !== KEY_LEN) throw new UsageError('clé de session : 256 bits attendus');

  // Un lien se donne : le fabriquer vers un bus en clair, c'est dégrader celui
  // qui l'ouvrira, sans qu'il ait rien demandé.
  const base = normaliseServeur(server, { allowInsecure, quoi: 'serveur ntfy du lien' });

  let fragment = `t=${topic}&k=${encodeB64u(key)}`;
  if (ro) fragment += '&ro=1';
  if (base !== DEFAULT_NTFY_BASE) fragment += `&s=${encodeB64u(utf8(base))}`;
  return `${withSlash(uiBase)}#${fragment}`;
}

/**
 * @param {string} url URL complète ou fragment nu (`#t=…&k=…`).
 * @param {{allowInsecure?:boolean}} options consentement à un bus local en clair.
 * @returns {{topic:string, key:Uint8Array, ro:boolean, server:string, uiBase:string|null}}
 */
export function parseSessionUrl(url, { allowInsecure = false } = {}) {
  if (typeof url !== 'string' || url.length === 0) throw new UsageError('URL de session attendue');
  const coupe = url.indexOf('#');
  if (coupe === -1) throw new UsageError("URL de session sans fragment : la clé n'y est pas");

  const uiBase = coupe > 0 ? withSlash(url.slice(0, coupe).replace(/\/+$/, '')) : null;
  const params = new URLSearchParams(url.slice(coupe + 1));

  const topic = params.get('t');
  if (!topic) throw new UsageError('topic absent de l\'URL (paramètre t)');
  if (!TOPIC_RE.test(topic)) throw new UsageError(`topic invalide : ${topic}`);

  const k = params.get('k');
  if (!k) throw new UsageError('clé absente de l\'URL (paramètre k)');
  let key;
  try {
    key = decodeB64u(k);
  } catch (cause) {
    throw new UsageError('clé de session illisible', { cause });
  }
  if (key.length !== KEY_LEN) throw new UsageError('clé de session : 256 bits attendus');

  const s = params.get('s');
  let server = DEFAULT_NTFY_BASE;
  if (s) {
    let brut;
    try {
      brut = fromUtf8(decodeB64u(s));
    } catch (cause) {
      throw new UsageError('serveur ntfy illisible dans l\'URL', { cause });
    }
    // Le lien vient d'un tiers : c'est le seul endroit où le bus est choisi par
    // quelqu'un d'autre que nous. Un `s=` en http:// ferait retomber en clair un
    // lecteur qui n'a fait qu'ouvrir un lien — on refuse plutôt que d'obéir.
    server = normaliseServeur(brut, { allowInsecure, quoi: 'serveur ntfy du lien' });
  }

  return { topic, key, ro: params.get('ro') === '1', server, uiBase };
}
