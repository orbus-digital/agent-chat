/**
 * Enveloppe des messages du salon : ce que nous mettons sur ntfy et ce que
 * nous acceptons d'en relire.
 *
 * Sur le fil :
 *   corps  = base64url(nonce||ct||tag)          (spec §2.1 — jamais autre chose)
 *   titre  = nom du participant                 (X-Title, en clair, assumé — D-01)
 *   tags   = [kind, "ts:<ms>", "sig:<b64u>"]    (voir ADR-001 : ntfy jette les en-têtes inconnus)
 *
 * Le clair, lui, ne quitte jamais le client : {v:1, text, meta?}.
 */

import { seal, open, buildAad, IntegrityError, nonceOf } from './crypto.js';
import { signBody, verifyBody } from './sign.js';

export const KINDS = ['text', 'file', 'control'];
export const TAG_TS = 'ts:';
export const TAG_SIG = 'sig:';
export const PAYLOAD_VERSION = 1;
export const MAX_FROM_LEN = 64;
/** R3 : au-delà, un ts qui recule n'est plus une horloge qui dérive. */
export const ORDER_TOLERANCE_MS = 60_000;

const findTag = (tags, prefix) => (Array.isArray(tags) ? tags.find((t) => typeof t === 'string' && t.startsWith(prefix)) : undefined);

function assertFrom(from) {
  if (typeof from !== 'string' || from.trim().length === 0) throw new TypeError("auteur : nom non vide attendu");
  if (from.length > MAX_FROM_LEN) throw new TypeError(`auteur : ${MAX_FROM_LEN} caractères au plus`);
  // `|` est le séparateur d'AAD : l'autoriser permettrait de confondre deux contextes.
  if (from.includes('|')) throw new TypeError("auteur : le caractère « | » est réservé");
  return from;
}

/**
 * @returns {{body:string, title:string, tags:string[], sig:string, ts:number, nonce:string}}
 */
export function encodeMessage({ key, kw, topic, from, kind = 'text', text, meta, ts = Date.now() }) {
  if (!KINDS.includes(kind)) throw new TypeError(`kind inconnu : ${kind} (attendu ${KINDS.join('|')})`);
  assertFrom(from);

  const payload = { v: PAYLOAD_VERSION, text: String(text ?? '') };
  if (meta !== undefined) payload.meta = meta;

  const body = seal({ key, topic, from, kind, ts, plaintext: Buffer.from(JSON.stringify(payload), 'utf8') });
  const sig = signBody(kw, body);
  return { body, title: from, tags: [kind, `${TAG_TS}${ts}`, `${TAG_SIG}${sig}`], sig, ts, nonce: nonceOf(body) };
}

/**
 * @param {{key:Buffer, kw:Buffer, topic:string, raw:object}} args message brut ntfy
 * @returns {null|{id, ts, time, from, kind, text, meta, verified, nonce, body}}
 *          `null` pour un événement de service ntfy (open / keepalive / poll_request).
 * @throws {IntegrityError} si le chiffré ne s'ouvre pas — rien de partiel n'est rendu (AC-05).
 */
export function decodeMessage({ key, kw, topic, raw }) {
  if (!raw || typeof raw !== 'object') throw new IntegrityError('message vide');
  if (raw.event && raw.event !== 'message') return null;

  const from = raw.title;
  if (typeof from !== 'string' || from.length === 0) throw new IntegrityError('auteur absent du message');

  const kind = (Array.isArray(raw.tags) ? raw.tags.find((t) => KINDS.includes(t)) : undefined) ?? 'text';

  const tagTs = findTag(raw.tags, TAG_TS);
  const ts = tagTs ? Number(tagTs.slice(TAG_TS.length)) : Number.NaN;
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new IntegrityError('horodatage absent ou illisible');

  if (typeof raw.message !== 'string' || raw.message.length === 0) throw new IntegrityError('corps absent');

  // Ouvre d'abord : sans clair authentifié, l'état « vérifié » n'a aucun sens à afficher.
  const clair = open({ key, topic, from, kind, ts, body: raw.message });
  let payload;
  try {
    payload = JSON.parse(clair.toString('utf8'));
  } catch (cause) {
    throw new IntegrityError('charge utile illisible', { cause });
  }
  if (payload?.v !== PAYLOAD_VERSION || typeof payload.text !== 'string') {
    throw new IntegrityError(`charge utile de version inattendue : ${payload?.v}`);
  }

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
    verified: verifyBody(kw, raw.message, sig),
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
