/**
 * Le salon vu de l'interface : ce que la page fait du bus.
 *
 * Cette classe n'utilise que `fetch` et le noyau partagé — jamais le DOM.
 * C'est ce qui permet de l'éprouver contre un serveur ntfy de test, sans
 * navigateur, et c'est aussi ce qui garantit que l'interface et le CLI
 * chiffrent, signent et vérifient exactement de la même façon.
 */

import { deriveWriteKey, IntegrityError } from '../lib/crypto.js';
import { encodeMessage, decodeMessage, ReplayGuard } from '../lib/protocol.js';
import { publish, subscribe, poll } from '../lib/ntfy.js';
import { buildExport, decodeExport } from '../lib/archive.js';
import { etatTtl, vueMessage, Roster } from './etat.js';

export const TTL_DEFAUT_H = 24;

/**
 * Santé du bus, telle que l'indicateur de connexion l'affiche (AC-13).
 *
 * Hors de la classe : l'accueil doit pouvoir interroger un bus **avant** qu'un
 * salon existe — c'est là qu'on le choisit, et c'est là qu'il faut savoir s'il
 * répond. Une seule implémentation pour les deux écrans.
 *
 * @returns {Promise<{healthy:boolean, raison?:string}>} jamais une exception :
 * un bus injoignable est un état à afficher, pas un incident à propager.
 */
export async function sonderSante({ base, fetchImpl = (...a) => fetch(...a) }) {
  try {
    const res = await fetchImpl(`${String(base).replace(/\/+$/, '')}/v1/health`);
    if (!res.ok) return { healthy: false, raison: `réponse ${res.status}` };
    const corps = await res.json();
    return corps?.healthy === true ? { healthy: true } : { healthy: false, raison: 'bus en panne' };
  } catch (err) {
    return { healthy: false, raison: err.message };
  }
}

export class Salon {
  #arret = null;
  #file = Promise.resolve();
  #garde = new ReplayGuard();
  #roster = new Roster();
  #kw = null;
  #rappels = {};

  /**
   * @param {{topic:string, key:Uint8Array, server:string, ro?:boolean,
   *          participant?:string|null, privateMeta?:boolean,
   *          fetchImpl?:Function, now?:Function}} options
   */
  constructor({ topic, key, server, ro = false, participant = null, privateMeta = false, fetchImpl, now }) {
    this.topic = topic;
    this.key = key;
    this.server = server;
    this.ro = ro;
    this.participant = participant;
    this.privateMeta = privateMeta;
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.now = now ?? (() => Date.now());
    this.connecte = false;
  }

  get participants() { return this.#roster.participants; }

  /** État de la durée de vie, tel que le roster l'a annoncé (R4). */
  get ttl() {
    return etatTtl({
      createdAt: this.#roster.createdAt,
      ttlH: this.#roster.ttlH ?? TTL_DEFAUT_H,
      maintenant: this.now(),
    });
  }

  /** Vrai tant qu'aucun roster n'a été lu : on ne sait pas encore. */
  get ttlInconnu() { return this.#roster.createdAt === null; }

  /**
   * @param {{onMessage:Function, onMigration?:Function, onEtat?:Function, onRoster?:Function}} rappels
   */
  async demarrer(rappels) {
    this.#rappels = rappels;
    this.#kw = await deriveWriteKey(this.key);
    this.#abonner('all');
  }

  #abonner(since) {
    this.#arret?.();
    this.#arret = subscribe({
      base: this.server,
      topic: this.topic,
      since,
      fetchImpl: this.fetchImpl,
      onMessage: (raw) => this.#enfiler(raw),
      onError: (err) => this.#etat(false, err.message),
    });
    this.#etat(true);
  }

  arreter() {
    this.#arret?.();
    this.#arret = null;
    this.#etat(false);
  }

  #etat(connecte, raison) {
    this.connecte = connecte;
    this.#rappels.onEtat?.({ connecte, raison });
  }

  /**
   * Le déchiffrement est asynchrone alors que les messages arrivent d'un
   * rappel synchrone : sans file, deux messages proches s'afficheraient dans
   * le désordre.
   */
  #enfiler(raw) {
    this.#file = this.#file.then(() => this.#traiter(raw)).catch(() => {});
  }

  async #traiter(raw) {
    let m;
    try {
      m = await decodeMessage({ key: this.key, kw: this.#kw, topic: this.topic, raw });
    } catch (err) {
      if (!(err instanceof IntegrityError)) throw err;
      this.#rappels.onMessage?.(vueMessage({ id: raw?.id ?? null, integrity: 'invalid' }));
      return;
    }
    if (m === null) return;

    const { duplicate } = this.#garde.check({ nonce: m.nonce, ts: m.ts });
    if (duplicate) return;

    this.#roster.appliquer(m);
    this.#rappels.onRoster?.(this.#roster.participants);
    this.#rappels.onMessage?.(vueMessage(m));

    // Un ordre de migration non vérifié n'en est pas un : il suffirait sinon
    // de connaître le nom du topic pour détourner tout le salon.
    if (m.kind === 'control' && m.meta?.type === 'migrate' && m.verified && typeof m.meta.topic === 'string') {
      this.topic = m.meta.topic;
      this.#garde = new ReplayGuard();
      this.#rappels.onMigration?.(m.meta.topic);
      this.#abonner('all');
    }
  }

  /** @throws si le droit d'écrire manque — l'interface n'affiche alors pas de zone de saisie. */
  async envoyer(texte, { kind = 'text', meta } = {}) {
    if (this.ro) throw new Error('Mode observateur : écriture refusée.');
    if (!this.participant) throw new Error('Choisissez un nom avant d’écrire.');
    if (!this.ttlInconnu && this.ttl.expire) throw new Error('Session expirée : écriture refusée, lecture et export restent possibles.');

    const env = await encodeMessage({
      key: this.key, kw: this.#kw ?? await deriveWriteKey(this.key), topic: this.topic,
      from: this.participant, kind, text: texte, meta, ts: this.now(),
      privateMeta: this.privateMeta,
    });
    return publish({
      base: this.server, topic: this.topic, body: env.body,
      title: env.title, tags: env.tags, sig: env.sig, fetchImpl: this.fetchImpl,
    });
  }

  /** Durée de vie et date de création connues, telles que le roster les porte. */
  get ttlH() { return this.#roster.ttlH ?? TTL_DEFAUT_H; }
  get createdAt() { return this.#roster.createdAt; }

  /**
   * Annonce sa présence et la durée de vie de la session (§4).
   * Sans argument, reprend ce que le roster déjà lu annonçait : un arrivant
   * ne redéfinit pas la durée de vie du salon qu'il rejoint.
   */
  async annoncer({ ttlH = this.ttlH, createdAt = this.createdAt ?? this.now() } = {}) {
    const participants = [...new Set([...this.#roster.participants, this.participant].filter(Boolean))];
    return this.envoyer('roster', {
      kind: 'control',
      meta: { type: 'roster', participants, ttlH, createdAt, expiresAt: createdAt + ttlH * 3600_000 },
    });
  }

  /** @returns {Promise<object>} l'export chiffré, tel qu'il sera enregistré. */
  async exporter() {
    const messages = await poll({ base: this.server, topic: this.topic, since: 'all', fetchImpl: this.fetchImpl });
    return buildExport({ topic: this.topic, server: this.server, messages, exportedAt: this.now() });
  }

  /** Relit un export **sans réseau** et rend chaque message à l'appelant (AC-09). */
  async importer(archive, onMessage) {
    const messages = await decodeExport({ key: this.key, exportObj: archive });
    for (const m of messages) onMessage(vueMessage(m));
    return messages.length;
  }

  /** Santé du bus de ce salon (AC-13). */
  sante() { return sonderSante({ base: this.server, fetchImpl: this.fetchImpl }); }
}
