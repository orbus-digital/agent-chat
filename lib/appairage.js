/**
 * Appairage sans serveur d'autorisation — ADR-003.
 *
 * Entrer dans un salon voulait dire **recevoir un lien qui porte la clé**. Un
 * fragment ne part jamais au serveur, c'est vrai ; mais le lien, lui, voyage —
 * presse-papiers, historique, ticket, capture d'écran — et chaque passage est
 * une copie complète du pouvoir de lire et d'écrire, qu'on ne peut pas révoquer.
 *
 * Ici, on garde l'expérience du code dicté (celle du *device login*, RFC 8628)
 * et on **supprime l'arbitre** : aucun serveur n'émet de code, ne garde d'état
 * ni ne délivre de jeton. Le bus sert de point de rendez-vous, la cryptographie
 * asymétrique remplace le serveur d'autorisation.
 *
 *   1. le demandeur tire une paire éphémère ECDH P-256 ;
 *   2. le **code EST l'empreinte** de sa clé publique — 10 caractères, ~50 bits ;
 *   3. il publie sa clé publique sur le sujet dérivé du code, et s'y abonne ;
 *   4. il dicte le code ;
 *   5. un membre saisit le code, relit la clé publique, **vérifie que son
 *      empreinte est exactement le code saisi**, et publie la clé de session
 *      scellée pour cette clé ;
 *   6. le demandeur ouvre et entre.
 *
 * **Le point qui fait tenir l'ensemble.** Le sujet est public : quiconque connaît
 * le code y lit la clé publique du demandeur. C'est sans conséquence — une clé
 * publique est publique. La seule attaque qui compte est la **substitution de
 * clé**, et la parade est que le code est l'empreinte : substituer une clé change
 * l'empreinte, donc le code saisi ne correspond plus, donc le membre refuse. C'est
 * le motif de la chaîne authentifiée courte, celui des numéros de sécurité de
 * Signal et des empreintes SSH.
 *
 * **Ce que ce fichier ne prétend pas résoudre**, et que la documentation répète :
 * la clé de session reste un **secret partagé** — l'appairage contrôle l'entrée,
 * pas la propagation ; et le canal par lequel le code voyage doit rester digne de
 * confiance, exactement comme un code affiché sur un téléviseur.
 *
 * Écrit en **WebCrypto pur**, sans `Buffer` ni import `node:*` : le même fichier
 * est chargé par le navigateur à travers `web/lib`, parce que l'interface doit
 * pouvoir autoriser. C'est aussi pourquoi la courbe est **P-256** et non X25519 :
 * WebCrypto la sert partout depuis 2017, quand X25519 n'est arrivé qu'en
 * Chrome 133+ et Safari 17+.
 */

import { encodeB64u, decodeB64u, utf8, fromUtf8, concat } from './bytes.js';
import { seal, open, hkdf256, KEY_LEN, IntegrityError } from './crypto.js';
import { TAG_TS, PRIVATE_TITLE } from './protocol.js';

/**
 * base32 « de Crockford » : l'alphabet retire `I`, `L`, `O` et `U`. Les trois
 * premiers parce qu'on les confond avec `1`, `1` et `0` — à l'œil comme à
 * l'oreille — et le dernier pour ne pas former de mot malheureux par hasard.
 */
export const ALPHABET_CODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 10 caractères = 50 bits (ADR-003). Voir `codeDepuisEmpreinte` pour le pourquoi. */
export const CODE_LEN = 10;
/** Cinq minutes, usage unique : la fenêtre de forçage est bornée par le temps. */
export const VALIDITE_MS = 5 * 60_000;

export const SUJET_PREFIXE = 'acp-';
export const SUJET_ENTROPIE = 24; // 192 bits → 32 caractères base64url
export const SUJET_RE = /^acp-[A-Za-z0-9_-]{32}$/;

export const COURBE = 'P-256';
export const VERSION = 1;
export const TAG_OFFRE = 'pair-offer';
export const TAG_OCTROI = 'pair-grant';
/** Un point P-256 non compressé : 0x04 || X(32) || Y(32). */
export const PK_LEN = 65;

/** Séparation de domaine : aucune empreinte ne doit servir deux protocoles. */
const CTX_EMPREINTE = 'agent-chat/appairage/empreinte/v1|';
const CTX_SUJET = 'agent-chat/appairage/sujet/v1|';
const CTX_SCELLEMENT = 'agent-chat/appairage/scellement/v1|';

const subtle = () => globalThis.crypto.subtle;

/**
 * Refus d'appairage. Les codes de retour restent ceux du CLI — on n'en invente
 * pas un sixième pour une cause qui entre dans les cinq existants :
 *   2 — le code saisi n'est pas un code (usage) ;
 *   3 — le code est périmé ou déjà consommé (le droit n'est plus là) ;
 *   5 — aucune clé ne répond de ce code, ou l'octroi ne s'ouvre pas (intégrité).
 */
export class AppairageError extends Error {
  constructor(message, { raison = 'appairage', exitCode = 5, ...options } = {}) {
    super(message, options);
    this.name = 'AppairageError';
    this.code = 'PAIRING';
    this.raison = raison;
    this.exitCode = exitCode;
  }
}

const refus = (raison, exitCode, message) => new AppairageError(message, { raison, exitCode });

// ------------------------------------------------------------------ le code

/**
 * Empreinte d'une clé publique brute : SHA-256 d'un contexte suivi de la clé.
 * Le contexte n'est pas décoratif — sans lui, la même empreinte pourrait servir
 * ici et dans un protocole voisin, et une preuve de l'un vaudrait pour l'autre.
 *
 * @param {Uint8Array} pubRaw point non compressé, 65 octets
 * @returns {Promise<Uint8Array>} 32 octets
 */
export async function empreinteDe(pubRaw) {
  if (!ArrayBuffer.isView(pubRaw) || pubRaw.length !== PK_LEN) {
    throw refus('cle-invalide', 5, `clé publique : ${PK_LEN} octets attendus (point P-256 non compressé)`);
  }
  return new Uint8Array(await subtle().digest('SHA-256', concat(utf8(CTX_EMPREINTE), pubRaw)));
}

/**
 * Les 50 premiers bits de l'empreinte, en base32.
 *
 * **Pourquoi 50 bits suffisent.** Le code n'est pas un secret à deviner : c'est
 * une *seconde préimage* à fabriquer. Un adversaire doit forger une paire dont
 * l'empreinte tombe exactement sur le code annoncé, en moins de cinq minutes.
 * 40 bits se forcent en quelques heures sur carte graphique ; 50 bits demandent
 * ~10¹⁵ essais. 60 bits seraient plus sûrs — et pénibles à dicter.
 */
export function codeDepuisEmpreinte(empreinte) {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    const bit = i * 5;
    const octet = bit >> 3;
    // Cinq bits sont à cheval sur deux octets au plus : on lit une fenêtre de
    // seize bits et on redescend jusqu'aux cinq voulus.
    const fenetre = ((empreinte[octet] << 8) | (empreinte[octet + 1] ?? 0)) >>> (11 - (bit & 7));
    code += ALPHABET_CODE[fenetre & 31];
  }
  return code;
}

/** @returns {Promise<string>} le code de 10 caractères d'une clé publique. */
export async function codeDe(pubRaw) {
  return codeDepuisEmpreinte(await empreinteDe(pubRaw));
}

/** Tel qu'on le dicte : `KXR7-2M4Q-9T`. */
export function formaterCode(code) {
  const c = String(code);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/**
 * La saisie est tolérante, la production ne l'est pas : on accepte les
 * minuscules, les tirets, les espaces, et on ramène les caractères que
 * l'alphabet a justement écartés (`I`, `L` → `1` ; `O` → `0`). `U` reste
 * invalide : il n'appartient pas à l'alphabet et ne se confond avec rien.
 *
 * @throws {AppairageError} raison `code-invalide`, code de retour 2
 */
export function normaliserCode(saisi) {
  if (typeof saisi !== 'string') throw refus('code-invalide', 2, 'code d\'appairage : une chaîne de 10 caractères est attendue');
  const propre = saisi.toUpperCase().replace(/[^0-9A-Z]/g, '').replaceAll('I', '1').replaceAll('L', '1').replaceAll('O', '0');
  if (propre.length !== CODE_LEN) {
    throw refus('code-invalide', 2, `code d'appairage « ${saisi} » : ${CODE_LEN} caractères attendus, ${propre.length} lus`);
  }
  for (const c of propre) {
    if (!ALPHABET_CODE.includes(c)) {
      throw refus('code-invalide', 2, `code d'appairage « ${saisi} » : le caractère « ${c} » n'appartient pas à l'alphabet`);
    }
  }
  return propre;
}

/**
 * Le sujet de rendez-vous, dérivé **du code seul** : un membre qui n'a que le
 * code doit pouvoir le calculer. C'est un haché, pas un encodage — le code ne
 * se relit donc pas dans le nom du sujet, même si connaître le sujet ne
 * protège de rien (il est public par construction).
 *
 * Le préfixe `acp-` ne peut pas satisfaire `TOPIC_RE` : un sujet d'appairage ne
 * sera jamais pris pour un topic de session, ni l'inverse.
 */
export async function sujetDe(code) {
  const c = normaliserCode(code);
  const h = new Uint8Array(await subtle().digest('SHA-256', utf8(CTX_SUJET + c)));
  return SUJET_PREFIXE + encodeB64u(h.subarray(0, SUJET_ENTROPIE));
}

// --------------------------------------------------------- côté demandeur

/**
 * Tout ce dont le demandeur a besoin : sa paire, son code, son sujet, et
 * l'offre à publier.
 *
 * @param {{ts?:number, validiteMs?:number}} options
 * @returns {Promise<{code, codeLisible, sujet, empreinte, pubRaw, paire, offre, ts, expiresAt}>}
 */
export async function ouvrirDemande({ ts = Date.now(), validiteMs = VALIDITE_MS } = {}) {
  const paire = await subtle().generateKey({ name: 'ECDH', namedCurve: COURBE }, true, ['deriveBits']);
  const pubRaw = new Uint8Array(await subtle().exportKey('raw', paire.publicKey));
  const empreinte = await empreinteDe(pubRaw);
  const code = codeDepuisEmpreinte(empreinte);
  const expiresAt = ts + validiteMs;

  return {
    code,
    codeLisible: formaterCode(code),
    sujet: await sujetDe(code),
    empreinte,
    pubRaw,
    paire,
    ts,
    expiresAt,
    offre: {
      body: encoderCharge({ v: VERSION, t: 'offer', pk: encodeB64u(pubRaw), ts, exp: expiresAt }),
      // Le titre est la constante des métadonnées privées : le bus n'apprend
      // ni qui demande, ni pour quel salon.
      title: PRIVATE_TITLE,
      tags: [TAG_OFFRE, `${TAG_TS}${ts}`],
    },
  };
}

/**
 * Lit un message brut du sujet et rend l'invitation **si elle nous est
 * adressée**, sinon `null`.
 *
 * @throws {IntegrityError} quand l'octroi nous vise mais ne s'ouvre pas : c'est
 *   le signe d'une clé substituée ou d'un chiffré altéré, pas d'un message
 *   étranger — et cela mérite d'être dit plutôt qu'ignoré.
 */
export async function lireOctroiPour({ demande, raw }) {
  const [octroi] = lireOctrois([raw]);
  if (!octroi) return null;
  if (octroi.to !== encodeB64u(demande.empreinte)) return null;

  const cle = await cleDeScellement({
    prive: demande.paire.privateKey,
    publiqueDistante: await importerPublique(octroi.pk),
    pkDemandeur: demande.pubRaw,
    pkMembre: octroi.pk,
    code: demande.code,
  });
  const clair = await open({
    key: cle, topic: demande.code, from: encodeB64u(demande.pubRaw), kind: encodeB64u(octroi.pk), ts: octroi.ts, body: octroi.ct,
  });

  let invitation;
  try {
    invitation = JSON.parse(fromUtf8(clair));
  } catch (cause) {
    throw new IntegrityError('invitation illisible', { cause });
  }
  if (invitation?.v !== VERSION) throw new IntegrityError(`invitation de version inattendue : ${invitation?.v}`);
  return invitation;
}

// ------------------------------------------------------------ côté membre

/**
 * Choisit, parmi tout ce qui traîne sur le sujet, l'offre dont l'empreinte
 * **est** le code saisi — et refuse tout le reste.
 *
 * Trois refus, et ce sont eux qui font l'appairage :
 *   - `aucune-offre` : aucune clé publiée ne répond de ce code. C'est le refus
 *     d'une **substitution de clé** : l'adversaire a publié la sienne, elle
 *     n'a pas la bonne empreinte, on s'arrête.
 *   - `code-expire` : au-delà de cinq minutes. La durée annoncée par l'offre
 *     n'est jamais crue au-delà de ce que le protocole accorde — sinon une
 *     offre pourrait s'octroyer un mois de validité.
 *   - `deja-consomme` : un octroi existe déjà pour cette empreinte. Le refus se
 *     mesure **sur le bus** et non dans un fichier local : il vaut donc pour
 *     tout membre, y compris celui qui n'a pas autorisé la première fois.
 *
 * @returns {Promise<{pk:Uint8Array, ts:number, expireA:number, empreinte:Uint8Array, id:string}>}
 */
export async function choisirOffre({ code, messages, maintenant = Date.now() }) {
  const c = normaliserCode(code);

  let retenue = null;
  // Le fil est lu dans l'ordre de publication : entre deux offres qui portent
  // le même code, la **première** l'emporte. Un arrivant tardif ne déplace pas
  // une offre déjà annonçable.
  for (const offre of lireOffres(messages)) {
    let empreinte;
    try {
      empreinte = await empreinteDe(offre.pk);
    } catch { continue; }
    if (codeDepuisEmpreinte(empreinte) !== c) continue;
    // Une clé qui n'est pas un point de la courbe ne sert à rien : l'écarter
    // ici évite de refuser tout l'appairage pour une offre malformée.
    try { await importerPublique(offre.pk); } catch { continue; }
    retenue = { ...offre, empreinte };
    break;
  }

  if (!retenue) {
    throw refus('aucune-offre', 5,
      `aucune clé publique publiée ne correspond au code ${formaterCode(c)} — clé substituée, code mal saisi, ou demandeur absent`);
  }

  const vise = encodeB64u(retenue.empreinte);
  if (lireOctrois(messages).some((o) => o.to === vise)) {
    throw refus('deja-consomme', 3,
      `code ${formaterCode(c)} déjà consommé : un octroi a été publié pour cette clé. Un code ne sert qu'une fois — demandez-en un neuf`);
  }

  // La validité EST bornée par le protocole : `exp` ne sert que de borne basse.
  const expireA = Math.min(Number(retenue.exp) || Number.POSITIVE_INFINITY, retenue.ts + VALIDITE_MS);
  if (maintenant >= expireA) {
    throw refus('code-expire', 3,
      `code ${formaterCode(c)} expiré : un code vaut ${VALIDITE_MS / 60_000} minutes. Demandez-en un neuf`);
  }

  return { ...retenue, expireA };
}

/**
 * Scelle l'invitation pour la clé publique du demandeur, et rend le message à
 * publier. Ne publie rien elle-même : le transport reste chez l'appelant, qui
 * seul connaît le bus et sa politique.
 *
 * @param {{code:string, messages:object[], invitation:object, maintenant?:number, ts?:number}} args
 */
export async function preparerOctroi({ code, messages, invitation, maintenant = Date.now(), ts = maintenant }) {
  assertInvitation(invitation);
  const offre = await choisirOffre({ code, messages, maintenant });
  const c = normaliserCode(code);

  const paire = await subtle().generateKey({ name: 'ECDH', namedCurve: COURBE }, true, ['deriveBits']);
  const pkMembre = new Uint8Array(await subtle().exportKey('raw', paire.publicKey));

  const cle = await cleDeScellement({
    prive: paire.privateKey,
    publiqueDistante: await importerPublique(offre.pk),
    pkDemandeur: offre.pk,
    pkMembre,
    code: c,
  });
  const ct = await seal({
    key: cle, topic: c, from: encodeB64u(offre.pk), kind: encodeB64u(pkMembre), ts,
    plaintext: utf8(JSON.stringify({ v: VERSION, ...invitation })),
  });

  return {
    code: c,
    sujet: await sujetDe(c),
    empreinte: offre.empreinte,
    octroi: {
      body: encoderCharge({ v: VERSION, t: 'grant', pk: encodeB64u(pkMembre), to: encodeB64u(offre.empreinte), ts, ct }),
      title: PRIVATE_TITLE,
      tags: [TAG_OCTROI, `${TAG_TS}${ts}`],
    },
  };
}

// ------------------------------------------------------------- lecture du fil

/** @returns {{pk:Uint8Array, ts:number, exp:number, id:string}[]} les offres lisibles, dans l'ordre. */
export function lireOffres(messages) {
  return chargesUtiles(messages, 'offer')
    .map(({ charge, id }) => ({ pk: octetsOuNull(charge.pk, PK_LEN), ts: entierOuNull(charge.ts), exp: Number(charge.exp), id }))
    .filter((o) => o.pk !== null && o.ts !== null);
}

/** @returns {{pk:Uint8Array, to:string, ts:number, ct:string, id:string}[]} */
export function lireOctrois(messages) {
  return chargesUtiles(messages, 'grant')
    .map(({ charge, id }) => ({
      pk: octetsOuNull(charge.pk, PK_LEN),
      to: typeof charge.to === 'string' ? charge.to : null,
      ts: entierOuNull(charge.ts),
      ct: typeof charge.ct === 'string' ? charge.ct : null,
      id,
    }))
    .filter((o) => o.pk !== null && o.to !== null && o.ts !== null && o.ct !== null);
}

// ------------------------------------------------------------------- outils

/** base64url(JSON) : le transport n'accepte pas autre chose (R1, `lib/ntfy.js`). */
function encoderCharge(objet) {
  return encodeB64u(utf8(JSON.stringify(objet)));
}

/**
 * Un message illisible n'est jamais une panne : sur un sujet public, n'importe
 * qui peut publier n'importe quoi. On écarte, on ne lève pas.
 */
function chargesUtiles(messages, type) {
  const out = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.event && raw.event !== 'message') continue;
    if (typeof raw.message !== 'string' || raw.message.length === 0) continue;
    let charge;
    try {
      charge = JSON.parse(fromUtf8(decodeB64u(raw.message)));
    } catch { continue; }
    if (charge?.v !== VERSION || charge.t !== type) continue;
    out.push({ charge, id: raw.id });
  }
  return out;
}

function octetsOuNull(b64u, taille) {
  if (typeof b64u !== 'string') return null;
  try {
    const o = decodeB64u(b64u);
    return o.length === taille ? o : null;
  } catch { return null; }
}

const entierOuNull = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/** Une clé publique invalide lève `DataError` : WebCrypto valide le point pour nous. */
async function importerPublique(pkRaw) {
  return subtle().importKey('raw', pkRaw, { name: 'ECDH', namedCurve: COURBE }, false, []);
}

/**
 * ECDH → HKDF-SHA-256 → clé AES-256-GCM.
 *
 * La dérivation est liée à la **transcription** : les deux clés publiques
 * entrent dans le sel, et le code dans l'information de contexte. Un octroi
 * rejoué sous une autre clé de membre ne produit donc pas la même clé, et
 * n'ouvre rien — c'est ce que vérifie le test « scellé pour une AUTRE clé ».
 */
async function cleDeScellement({ prive, publiqueDistante, pkDemandeur, pkMembre, code }) {
  const partage = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publiqueDistante }, prive, 256));
  const sel = new Uint8Array(await subtle().digest('SHA-256', concat(pkDemandeur, pkMembre)));
  return hkdf256({ ikm: partage, salt: sel, info: CTX_SCELLEMENT + code });
}

/**
 * Ce qu'un membre a le droit de sceller : de quoi écrire un fichier de session
 * complet, et rien de plus. Vérifié **avant** de choisir une offre, pour ne pas
 * consommer un code au profit d'une invitation inutilisable.
 */
function assertInvitation(invitation) {
  const mauvais = (quoi) => refus('invitation-invalide', 2, `invitation d'appairage : ${quoi}`);
  if (!invitation || typeof invitation !== 'object') throw mauvais('un objet est attendu');
  if (typeof invitation.topic !== 'string' || invitation.topic.length === 0) throw mauvais('topic absent');
  if (typeof invitation.k !== 'string' || octetsOuNull(invitation.k, KEY_LEN) === null) {
    throw mauvais('clé de session : 256 bits en base64url attendus');
  }
  if (typeof invitation.server !== 'string' || invitation.server.length === 0) throw mauvais('serveur absent');
  return invitation;
}
