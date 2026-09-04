/**
 * Enveloppe des messages du salon : ce que nous mettons sur ntfy et ce que
 * nous acceptons d'en relire.
 *
 * Sur le fil :
 *   corps  = base64url(nonce||ct||tag)          (spec §2.1 — jamais autre chose)
 *   titre  = nom du participant                 (X-Title, en clair, assumé — D-01)
 *   tags   = [kind, "ts:<ms>", "sig:<b64u>"]    (voir ADR-001 : ntfy jette les en-têtes inconnus)
 *
 * En mode `--private-meta` (AC-15), le titre et le tag de kind deviennent des
 * **constantes** (`ac`, `m`) et l'auteur comme le kind passent dans le clair
 * chiffré. L'AAD est alors construite sur ces constantes : elle décrit toujours
 * ce qui est réellement publié, donc reste vérifiable par un destinataire qui
 * n'a pas encore ouvert le message.
 *
 * Le clair, lui, ne quitte jamais le client : {v:1, ts, text, from?, kind?, meta?}.
 */

import { seal, open, buildAad, IntegrityError, nonceOf } from './crypto.js';
import { signBody, verifyBody } from './sign.js';
import { utf8, fromUtf8 } from './bytes.js';

export const KINDS = ['text', 'file', 'control'];
export const TAG_TS = 'ts:';
export const TAG_SIG = 'sig:';
export const PAYLOAD_VERSION = 1;
export const MAX_FROM_LEN = 64;
/** AC-15 : les constantes publiées quand les métadonnées sont privées. */
export const PRIVATE_TITLE = 'ac';
export const PRIVATE_KIND = 'm';
/** R3 : au-delà, un ts qui recule n'est plus une horloge qui dérive. */
export const ORDER_TOLERANCE_MS = 60_000;

const findTag = (tags, prefix) => (Array.isArray(tags) ? tags.find((t) => typeof t === 'string' && t.startsWith(prefix)) : undefined);

function assertFrom(from) {
  if (typeof from !== 'string' || from.trim().length === 0) throw new TypeError('auteur : nom non vide attendu');
  if (from.length > MAX_FROM_LEN) throw new TypeError(`auteur : ${MAX_FROM_LEN} caractères au plus`);
  // `|` est le séparateur d'AAD : l'autoriser permettrait de confondre deux contextes.
  if (from.includes('|')) throw new TypeError('auteur : le caractère « | » est réservé');
  return from;
}

/**
 * @returns {Promise<{body:string, title:string, tags:string[], sig:string, ts:number, nonce:string}>}
 */
export async function encodeMessage({ key, kw, topic, from, kind = 'text', text, meta, ts = Date.now(), privateMeta = false }) {
  if (!KINDS.includes(kind)) throw new TypeError(`kind inconnu : ${kind} (attendu ${KINDS.join('|')})`);
  assertFrom(from);

  const title = privateMeta ? PRIVATE_TITLE : from;
  const kindTag = privateMeta ? PRIVATE_KIND : kind;

  const payload = { v: PAYLOAD_VERSION, ts, text: String(text ?? '') };
  if (privateMeta) { payload.from = from; payload.kind = kind; }
  if (meta !== undefined) payload.meta = meta;

  const body = await seal({ key, topic, from: title, kind: kindTag, ts, plaintext: utf8(JSON.stringify(payload)) });
  const sig = await signBody(kw, body);
  return { body, title, tags: [kindTag, `${TAG_TS}${ts}`, `${TAG_SIG}${sig}`], sig, ts, nonce: nonceOf(body), privateMeta };
}

/**
 * @param {{key:Uint8Array, kw:Uint8Array, topic:string, raw:object}} args message brut ntfy
 * @returns {Promise<null|object>} `null` pour un événement de service ntfy
 *          (open / keepalive / poll_request).
 * @throws {IntegrityError} si le chiffré ne s'ouvre pas — rien de partiel n'est rendu (AC-05).
 */
export async function decodeMessage({ key, kw, topic, raw }) {
  if (!raw || typeof raw !== 'object') throw new IntegrityError('message vide');
  if (raw.event && raw.event !== 'message') return null;

  const title = raw.title;
  if (typeof title !== 'string' || title.length === 0) throw new IntegrityError('auteur absent du message');

  const kindTag = (Array.isArray(raw.tags)
    ? raw.tags.find((t) => KINDS.includes(t) || t === PRIVATE_KIND)
    : undefined) ?? 'text';

  const tagTs = findTag(raw.tags, TAG_TS);
  const ts = tagTs ? Number(tagTs.slice(TAG_TS.length)) : Number.NaN;
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new IntegrityError('horodatage absent ou illisible');

  if (typeof raw.message !== 'string' || raw.message.length === 0) throw new IntegrityError('corps absent');

  // Ouvre d'abord : sans clair authentifié, l'état « vérifié » n'a aucun sens à afficher.
  const clair = await open({ key, topic, from: title, kind: kindTag, ts, body: raw.message });
  let payload;
  try {
    payload = JSON.parse(fromUtf8(clair));
  } catch (cause) {
    throw new IntegrityError('charge utile illisible', { cause });
  }
  if (payload?.v !== PAYLOAD_VERSION || typeof payload.text !== 'string') {
    throw new IntegrityError(`charge utile de version inattendue : ${payload?.v}`);
  }
  // L'horodatage est à la fois dans l'AAD et dans le clair : la contradiction
  // signalerait un chiffré recyclé sous un autre tag, elle n'est pas tolérée.
  if (payload.ts !== undefined && payload.ts !== ts) {
    throw new IntegrityError('horodatage du clair incohérent avec celui publié');
  }

  const prive = title === PRIVATE_TITLE && kindTag === PRIVATE_KIND;
  const from = prive ? (payload.from ?? PRIVATE_TITLE) : title;
  const kind = prive ? (KINDS.includes(payload.kind) ? payload.kind : 'text') : kindTag;

  const sigTag = findTag(raw.tags, TAG_SIG);
  const sig = sigTag ? sigTag.slice(TAG_SIG.length) : null;

  return {
    id: raw.id,
    ts,
    time: raw.time ?? Math.floor(ts / 1000),
    from,
    kind,
    text: payload.text,
    meta: payload.meta,
    verified: await verifyBody(kw, raw.message, sig),
    privateMeta: prive,
    nonce: nonceOf(raw.message),
    body: raw.message,
  };
}

/**
 * Mémoire courte du client : refuse un nonce déjà vu (rejeu) et signale un
 * `ts` qui recule franchement (R3). Bornée, parce qu'un salon peut vivre
 * longtemps et qu'un ensemble qui grossit sans fin est une fuite.
 */
export class ReplayGuard {
  #nonces = new Set();
  #maxNonces;
  #lastTs = null;

  constructor({ maxNonces = 5000 } = {}) {
    this.#maxNonces = maxNonces;
  }

  get size() { return this.#nonces.size; }
  get lastTs() { return this.#lastTs; }

  /** @returns {{duplicate:boolean, outOfOrder:boolean}} */
  check({ nonce, ts }) {
    const duplicate = this.#nonces.has(nonce);
    const outOfOrder = !duplicate && this.#lastTs !== null && ts < this.#lastTs - ORDER_TOLERANCE_MS;

    if (!duplicate) {
      this.#nonces.add(nonce);
      while (this.#nonces.size > this.#maxNonces) {
        this.#nonces.delete(this.#nonces.values().next().value);
      }
      if (this.#lastTs === null || ts > this.#lastTs) this.#lastTs = ts;
    }
    return { duplicate, outOfOrder };
  }
}

export { buildAad };
