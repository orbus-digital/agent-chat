/**
 * URL capacitaire : tout le pouvoir de lire est dans le fragment, et un
 * fragment n'est jamais envoyé au serveur par un navigateur (R1).
 *
 *   https://<pages>/#t=<topic>&k=<K base64url>[&ro=1][&s=<serveur ntfy base64url>]
 */

import { encodeB64u, decodeB64u } from './base64url.js';
import { KEY_LEN, TOPIC_RE } from './crypto.js';

export const DEFAULT_UI_BASE = 'https://orbus-digital.github.io/agent-chat/';
export const DEFAULT_NTFY_BASE = 'https://ntfy.sh';

/** Mauvais usage : le CLI la traduit en code 2. */
export class UsageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UsageError';
    this.code = 'USAGE';
    this.exitCode = 2;
  }
}

const withSlash = (base) => (base.endsWith('/') ? base : `${base}/`);
const stripSlash = (base) => base.replace(/\/+$/, '');

export function buildSessionUrl({ topic, key, ro = false, server = DEFAULT_NTFY_BASE, uiBase = DEFAULT_UI_BASE }) {
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new UsageError(`topic invalide : ${topic}`);
  if (!ArrayBuffer.isView(key) || key.length !== KEY_LEN) throw new UsageError('clé de session : 256 bits attendus');

  let fragment = `t=${topic}&k=${encodeB64u(key)}`;
  if (ro) fragment += '&ro=1';
  if (stripSlash(server) !== DEFAULT_NTFY_BASE) fragment += `&s=${encodeB64u(Buffer.from(stripSlash(server), 'utf8'))}`;
  return `${withSlash(uiBase)}#${fragment}`;
}

/**
 * @param {string} url URL complète ou fragment nu (`#t=…&k=…`).
 * @returns {{topic:string, key:Buffer, ro:boolean, server:string, uiBase:string|null}}
 */
export function parseSessionUrl(url) {
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
    try {
      server = stripSlash(decodeB64u(s).toString('utf8'));
    } catch (cause) {
      throw new UsageError('serveur ntfy illisible dans l\'URL', { cause });
    }
  }

  return { topic, key, ro: params.get('ro') === '1', server, uiBase };
}
