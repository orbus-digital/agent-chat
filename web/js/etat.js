/**
 * Couche d'état de l'interface : tout ce qui décide **quoi** montrer, isolé de
 * **comment** le montrer.
 *
 * Les règles observables du salon vivent ici — mode observateur, clé absente,
 * durée de vie, présentation d'un message non vérifié — de sorte qu'elles
 * soient éprouvables sans navigateur, et qu'un changement d'apparence ne
 * puisse pas les altérer par mégarde.
 */

import { parseSessionUrl } from '../lib/url.js';

/** Format d'heure affiché à côté de chaque message. */
export const HORAIRE = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * @param {string|null|undefined} hash le `location.hash`
 * @returns {{ok:true, topic, key, ro, server} | {ok:false, raison, message}}
 *
 * Un lien incomplet ne laisse **rien** filtrer du salon : ni le topic, ni la
 * moitié d'une clé. Sans le fragment, il n'y a rien à montrer (AC-06).
 */
export function lireFragment(hash) {
  const brut = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (brut.length === 0) return { ok: false, raison: 'accueil' };

  try {
    const { topic, key, ro, server } = parseSessionUrl(`#${brut}`);
    return { ok: true, topic, key, ro, server };
  } catch (err) {
    const sansCle = /clé/i.test(err.message);
    return {
      ok: false,
      raison: sansCle ? 'cle-absente' : 'lien-invalide',
      message: sansCle
        ? 'Clé absente : ce lien ne porte pas la clé de session, rien ne peut être déchiffré.'
        : `Lien invalide : ${err.message}`,
    };
  }
}

/**
 * @returns {{expiresAt:number|null, expire:boolean, reste:number, resteLisible:string}}
 * Une session dont on ignore la date de création est traitée comme expirée :
 * c'est le sens prudent du doute.
 */
export function etatTtl({ createdAt, ttlH = 24, maintenant = Date.now() }) {
  if (!Number.isFinite(createdAt)) {
    return { expiresAt: null, expire: true, reste: 0, resteLisible: '—' };
  }
  const expiresAt = createdAt + ttlH * 3600_000;
  const reste = Math.max(0, expiresAt - maintenant);
  return { expiresAt, expire: maintenant >= expiresAt, reste, resteLisible: lisible(reste) };
}

function lisible(ms) {
  if (ms <= 0) return 'expirée';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.round(minutes / 60);
  return `${heures} h`;
}

/**
 * R7 et R4 réunis. La zone d'écriture n'est pas seulement désactivée quand
 * ceci est faux : elle n'est pas rendue (AC-06).
 */
export function peutEcrire({ ro, expire, cle }) {
  return Boolean(cle) && !ro && !expire;
}

const deuxChiffres = (n) => String(n).padStart(2, '0');

/**
 * @param {object} m message déchiffré, ou marqueur d'intégrité invalide
 * @returns {{id, auteur, heure, kind, texte, verifie, invalide, control, mention}}
 */
export function vueMessage(m) {
  if (m?.integrity === 'invalid') {
    return {
      id: m.id ?? null,
      auteur: '—',
      heure: '',
      kind: '',
      texte: '',                 // rien de partiel n'est rendu (AC-05)
      verifie: false,
      invalide: true,
      control: false,
      mention: 'intégrité invalide',
    };
  }

  const d = new Date(m.ts);
  const control = m.kind === 'control';
  return {
    id: m.id ?? null,
    auteur: m.from,
    heure: `${deuxChiffres(d.getHours())}:${deuxChiffres(d.getMinutes())}`,
    kind: m.kind,
    texte: control ? resumeControle(m) : m.text,
    verifie: Boolean(m.verified),
    invalide: false,
    control,
    mention: m.verified ? '' : 'non vérifié',
  };
}

/** Les messages de contrôle sont affichés, mais en clair de lecture (§4). */
function resumeControle(m) {
  const type = m.meta?.type;
  if (type === 'roster') {
    const gens = m.meta.participants ?? [];
    return `roster — ${gens.length} participant(s)${gens.length ? ` : ${gens.join(', ')}` : ''}`;
  }
  if (type === 'migrate') return `migration vers un nouveau topic (${m.meta.topic})`;
  if (type === 'end') return 'fin de session annoncée';
  return m.text;
}

/**
 * Qui est là, et pour combien de temps. Un participant n'est inscrit que par
 * un message **vérifié** : sinon, il suffirait de publier sous un nom pour
 * apparaître dans la liste des présents.
 */
export class Roster {
  #gens = [];

  constructor() {
    this.ttlH = null;
    this.createdAt = null;
  }

  get participants() { return [...this.#gens]; }

  appliquer(m) {
    if (!m) return this;
    if (m.kind === 'control' && m.meta?.type === 'roster') {
      for (const p of m.meta.participants ?? []) this.#ajouter(p);
      if (Number.isFinite(m.meta.ttlH)) this.ttlH = m.meta.ttlH;
      if (Number.isFinite(m.meta.createdAt)) this.createdAt = m.meta.createdAt;
      return this;
    }
    if (m.verified && typeof m.from === 'string') this.#ajouter(m.from);
    return this;
  }

  #ajouter(nom) {
    if (typeof nom === 'string' && nom.length > 0 && !this.#gens.includes(nom)) this.#gens.push(nom);
  }
}
