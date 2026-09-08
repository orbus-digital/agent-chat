/**
 * La politique d'adressage du bus : quel serveur ntfy ce client accepte de
 * joindre. Un seul fichier décide ; quatre couches l'appellent — l'option
 * `--server` du CLI, l'environnement (`NTFY_BASE_URL`), le paramètre `s` du
 * lien de session, et le transport juste avant de parler au réseau.
 *
 * **Pourquoi https:// n'est pas négociable.** Le corps des messages est chiffré :
 * un bus en clair ne trahit pas ce qui se dit. Mais les *métadonnées* voyagent
 * en en-têtes HTTP — `X-Title` (l'auteur), `X-Tags` (le kind) — et le nom du
 * topic est dans le chemin de l'URL. Sur http://, un observateur du réseau lit
 * qui parle à qui, quand, et sur quel salon ; il peut aussi rejouer ou injecter.
 * `--private-meta`, qui existe précisément pour cacher l'auteur et le kind au
 * bus, ne protège alors plus de rien vis-à-vis de cet observateur.
 *
 * **Deux niveaux, volontairement.**
 *   - `assertBaseTransport` porte l'invariant *objectif* — jamais de clair vers
 *     le réseau — et laisse passer la boucle locale sans rien demander : la
 *     couche réseau ne connaît pas l'intention de son appelant, et un serveur de
 *     test sur 127.0.0.1 ne sort pas de la machine.
 *   - `normaliseServeur` porte la *politique*, plus stricte : le clair exige un
 *     consentement explicite (`--allow-insecure`) **en plus** d'être local.
 * Un seul niveau n'aurait pas suffi : au transport seul, `--server http://localhost`
 * passait en silence ; à la politique seule, tout appelant du noyau la contournait.
 *
 * Ce module ne dépend de rien — ni `node:*`, ni `Buffer` : il est chargé tel quel
 * par le navigateur à travers `web/lib` (noyau isomorphe).
 */

/** Le bus public, en https. */
export const DEFAULT_NTFY_BASE = 'https://ntfy.sh';

/**
 * Mauvais usage : le CLI la traduit en code 2.
 *
 * Elle vit ici plutôt que dans `url.js` parce que c'est ici qu'est le refus le
 * plus ancien du programme ; `url.js` la ré-exporte pour ses appelants d'origine.
 */
export class UsageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UsageError';
    this.code = 'USAGE';
    this.exitCode = 2;
  }
}

const sansSlash = (base) => String(base).replace(/\/+$/, '');

/**
 * La boucle locale : `localhost`, toute la plage 127.0.0.0/8, et `::1`.
 * `new URL()` rend l'IPv6 entre crochets — les deux écritures sont acceptées.
 */
export function estBoucleLocale(hote) {
  const h = String(hote).toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Vrai si cette origine est une origine de mise au point : servie en clair,
 * depuis la boucle locale. L'interface s'en sert pour savoir si elle a le droit
 * de proposer un bus local — sur une page https, la question ne se pose pas.
 */
export function origineDeDeveloppement(origine) {
  try {
    const u = new URL(String(origine));
    return u.protocol === 'http:' && estBoucleLocale(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Valide et normalise une URL de bus.
 *
 * @param {string} brut l'URL telle qu'elle a été saisie ou reçue
 * @param {{allowInsecure?:boolean, quoi?:string}} options
 *   `allowInsecure` — le consentement explicite de l'utilisateur ; il ne vaut
 *   que pour la boucle locale. `quoi` — ce qu'on nomme dans le message d'erreur.
 * @returns {string} la même URL, sans barre finale
 * @throws {UsageError} avec un message qui dit quoi écrire à la place
 */
export function normaliseServeur(brut, { allowInsecure = false, quoi = 'serveur ntfy' } = {}) {
  if (typeof brut !== 'string' || brut.trim().length === 0) {
    throw new UsageError(`${quoi} : une URL est attendue, par exemple ${DEFAULT_NTFY_BASE}`);
  }
  const propre = sansSlash(brut.trim());

  let u;
  try {
    u = new URL(propre);
  } catch {
    throw new UsageError(`${quoi} « ${propre} » : URL illisible — une adresse complète est attendue, schéma compris (${DEFAULT_NTFY_BASE})`);
  }

  if (u.protocol === 'https:') return propre;

  if (u.protocol !== 'http:') {
    throw new UsageError(`${quoi} « ${propre} » : schéma ${u.protocol}// refusé — https:// attendu`);
  }

  // Un https:// à proposer dans le message : un refus qui ne dit pas quoi
  // écrire à la place se contourne en désactivant la garde.
  const propose = `https://${u.host}${sansSlash(u.pathname)}`;

  if (!estBoucleLocale(u.hostname)) {
    const pourquoi = allowInsecure
      ? '--allow-insecure ne vaut que pour la boucle locale (localhost, 127.0.0.1, [::1])'
      : 'les en-têtes ntfy X-Title et X-Tags, et le nom du topic, voyageraient en clair';
    throw new UsageError(`${quoi} « ${propre} » : http:// refusé — ${pourquoi}. Écrivez ${propose}`);
  }

  if (!allowInsecure) {
    throw new UsageError(`${quoi} « ${propre} » : http:// refusé — ajoutez --allow-insecure (ou AGENTCHAT_ALLOW_INSECURE=1) si c'est bien un serveur de test local`);
  }

  return propre;
}

/**
 * Garde du transport. Le consentement y est implicite : cette couche ne peut
 * pas savoir ce que l'utilisateur a demandé, elle ne refuse donc que ce qui est
 * objectivement une fuite — du clair qui quitte la machine.
 */
export function assertBaseTransport(base, quoi = 'serveur ntfy') {
  return normaliseServeur(base, { allowInsecure: true, quoi });
}
