/**
 * Archive de session : le seul stockage durable du système (R8, D-04).
 *
 * ntfy garde une conversation 12 h ; au-delà elle n'existe que dans les
 * exports locaux des participants. Un export ne contient **que du chiffré**,
 * exactement tel que le bus l'a rendu : il est donc aussi peu sensible que le
 * bus lui-même, et se relit avec `K` — par le CLI (`replay`) comme par
 * l'interface (bouton « Importer »).
 *
 * Isomorphe : ce module est chargé par le navigateur comme par le CLI.
 */

import { decodeMessage } from './protocol.js';
import { deriveWriteKey, IntegrityError } from './crypto.js';
import { TOPIC_RE } from './crypto.js';

export const EXPORT_VERSION = 1;

/** Erreur de forme d'un fichier d'export. Le CLI la traduit en code 2. */
export class ArchiveError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ArchiveError';
    this.code = 'ARCHIVE';
    this.exitCode = 2;
  }
}

/**
 * @param {{topic:string, server:string, messages:object[], exportedAt?:number}} args
 * @returns {{v:number, topic:string, server:string, exportedAt:string, messages:object[]}}
 */
export function buildExport({ topic, server, messages, exportedAt = Date.now() }) {
  if (!TOPIC_RE.test(topic ?? '')) throw new ArchiveError(`topic invalide : ${topic}`);
  return {
    v: EXPORT_VERSION,
    topic,
    server,
    exportedAt: new Date(exportedAt).toISOString(),
    // Les messages sont conservés tels que ntfy les a rendus : ni tri, ni
    // réécriture. Un export est une copie, pas une interprétation.
    messages: messages.filter((m) => m && (!m.event || m.event === 'message')),
  };
}

/** Valide la forme d'un export lu depuis un fichier ou un presse-papier. */
export function readExport(objet) {
  if (!objet || typeof objet !== 'object') throw new ArchiveError('export illisible : objet attendu');
  if (objet.v !== EXPORT_VERSION) throw new ArchiveError(`export de version inattendue : ${objet.v}`);
  if (!TOPIC_RE.test(objet.topic ?? '')) throw new ArchiveError(`export sans topic valide : ${objet.topic}`);
  if (!Array.isArray(objet.messages)) throw new ArchiveError('export sans liste de messages');
  return { topic: objet.topic, server: objet.server ?? null, exportedAt: objet.exportedAt ?? null, messages: objet.messages };
}

/**
 * Déchiffre un export **sans réseau** (AC-09).
 * @returns {Promise<Array>} un élément par message, dans l'ordre du fichier ;
 *          un message illisible devient `{integrity:'invalid'}` plutôt que de
 *          faire échouer la relecture entière.
 */
export async function decodeExport({ key, exportObj }) {
  const { topic, messages } = readExport(exportObj);
  const kw = await deriveWriteKey(key);
  const out = [];
  for (const raw of messages) {
    try {
      const m = await decodeMessage({ key, kw, topic, raw });
      if (m !== null) out.push(m);
    } catch (err) {
      if (!(err instanceof IntegrityError)) throw err;
      out.push({ id: raw?.id ?? null, integrity: 'invalid', verified: false, reason: err.message });
    }
  }
  return out;
}
