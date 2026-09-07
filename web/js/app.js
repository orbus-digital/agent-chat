/**
 * Liaison entre le salon et la page. Cette couche ne décide rien : elle rend
 * ce que `etat.js` et `salon.js` ont décidé. Tout ce qu'elle touche du monde
 * (document, adresse, presse-papier, fichiers, horloge) lui est passé, pour
 * que les règles observables d'AC-06 soient éprouvables sans navigateur.
 */

import { generateKey, generateTopic } from '../lib/crypto.js';
import { buildSessionUrl, DEFAULT_NTFY_BASE } from '../lib/url.js';
import { lireFragment, peutEcrire, etatTtl } from './etat.js';
import { Salon, sonderSante } from './salon.js';
import { versSvg } from './qr.js';

/** La politique de sécurité de la page ne laisse joindre que ces bus. */
export const BUS_AUTORISES = ['https://ntfy.sh'];
const RAFRAICHIR_TTL_MS = 30_000;

const sansSlash = (s) => String(s).replace(/\/+$/, '');

/** En deçà de cette distance du bas, le lecteur est réputé suivre le direct. */
export const MARGE_BAS_PX = 120;

/**
 * Le fil suit le dernier message — sauf si le lecteur est remonté lire.
 *
 * Ce n'est **pas** une mesure de la distance au bas de la page : pendant une
 * rafale d'arrivée, le fil grandit plus vite qu'il ne défile, et cette distance
 * dépasse aussitôt n'importe quel seuil. Le lecteur, lui, n'a rien fait. On
 * suit donc son geste : remonter arrête le suivi, redescendre au bas le
 * reprend. Un défilement provoqué par nous va toujours vers le bas, il ne peut
 * donc pas se prendre pour un geste du lecteur.
 *
 * @param {{documentElement?:{scrollHeight:number, scrollTop:number, clientHeight:number}}} doc
 * @param {{addEventListener?:Function}|null} fenetre
 */
export function defilementDeLaFenetre(doc, fenetre = null, marge = MARGE_BAS_PX) {
  const haut = () => doc?.documentElement?.scrollTop ?? 0;
  const distanceAuBas = () => {
    const d = doc?.documentElement;
    // Sans mesure possible, on suit : ne pas voir arriver un message est pire
    // que d'être ramené en bas.
    if (!d || !Number.isFinite(d.scrollHeight) || !Number.isFinite(d.clientHeight)) return 0;
    return d.scrollHeight - (d.scrollTop ?? 0) - d.clientHeight;
  };

  let suit = true;
  let precedent = haut();
  fenetre?.addEventListener?.('scroll', () => {
    const courant = haut();
    if (courant < precedent - 2) suit = false;
    else if (distanceAuBas() <= marge) suit = true;
    precedent = courant;
  }, { passive: true });

  return {
    auBas: () => suit,
    vers: (el) => el?.scrollIntoView?.({ block: 'end' }),
  };
}

export function busAutorise(url, origine = null) {
  const propre = sansSlash(url);
  return BUS_AUTORISES.includes(propre) || (origine !== null && propre === sansSlash(origine));
}

/**
 * @param {object} monde { document, location, now, fabriqueSalon, presse, minuteur, telecharger, lireFichier }
 * @returns {object} l'application, pour l'éprouver
 */
export function demarrer(monde) {
  const {
    document: doc,
    location: adresse,
    now = () => Date.now(),
    fabriqueSalon = (options) => new Salon(options),
    presse = null,
    minuteur = { repeter: (fn, ms) => setInterval(fn, ms), arreter: (id) => clearInterval(id) },
    telecharger = null,
    lireFichier = null,
    memoire = null,
    fetchImpl = (...a) => fetch(...a),
    fenetre = null,
    defilement = defilementDeLaFenetre(doc, fenetre),
  } = monde;

  const $ = (id) => doc.getElementById(id);
  const app = { salon: null, vue: null, participant: null };

  // ------------------------------------------------------------- rendu

  const montrer = (vue) => {
    app.vue = vue;
    for (const nom of ['accueil', 'salon', 'erreur']) $(`vue-${nom}`).hidden = nom !== vue;
  };

  const avis = (texte) => {
    const p = $('avis-salon');
    p.textContent = texte ?? '';
    p.hidden = !texte;
  };

  function ajouterMessage(v) {
    const li = doc.createElement('li');
    li.className = ['message', v.control ? 'controle' : '', v.invalide ? 'invalide' : '', v.verifie ? '' : 'non-verifie']
      .filter(Boolean).join(' ');

    const entete = doc.createElement('p');
    entete.className = 'message-entete';

    const auteur = doc.createElement('span');
    auteur.className = 'auteur';
    auteur.textContent = v.auteur;
    entete.append(auteur);

    const heure = doc.createElement('time');
    heure.className = 'heure';
    heure.textContent = v.heure;
    entete.append(heure);

    // Auteur, heure, kind et état vérifié sont tous les quatre affichés, pour
    // chaque message : c'est ce que le lecteur doit pouvoir juger (AC-06).
    if (v.kind) {
      const kind = doc.createElement('span');
      kind.className = 'kind';
      kind.textContent = v.kind;
      entete.append(kind);
    }
    if (v.mention) {
      const mention = doc.createElement('span');
      mention.className = `mention ${v.verifie ? 'mention-verifie' : 'mention-doute'}`;
      mention.textContent = v.mention;
      entete.append(mention);
    }

    const corps = doc.createElement('p');
    corps.className = 'message-texte';
    // `textContent` et non `innerHTML` : un message est du texte, jamais du balisage.
    corps.textContent = v.texte;

    li.append(entete);
    li.append(corps);

    // Mesuré avant l'ajout : après, la hauteur a changé et plus personne n'est
    // « en bas ». Un fil qui s'affiche en direct doit montrer ce qui arrive.
    const suivre = defilement.auBas();
    $('fil').append(li);
    if (suivre) defilement.vers(li);
    return li;
  }

  function rafraichirEntete() {
    const s = app.salon;
    if (!s) return;
    $('topic-court').textContent = `${s.topic.slice(0, 11)}…`;
    $('serveur-courant').textContent = s.server;
    $('roster').textContent = s.participants.length ? s.participants.join(', ') : '—';
    $('ttl-restant').textContent = s.ttlInconnu ? '—' : s.ttl.resteLisible;
    rafraichirEcriture();
  }

  /**
   * AC-06 : en mode observateur la zone d'écriture n'est pas seulement
   * désactivée, elle n'est pas affichée. Il en va de même passé le TTL.
   */
  function rafraichirEcriture() {
    const s = app.salon;
    const expire = s ? (!s.ttlInconnu && s.ttl.expire) : false;
    const autorise = peutEcrire({ ro: s?.ro, expire, cle: Boolean(s) });
    // Le droit d'écrire précède le fait de s'être nommé : sans le premier,
    // même la demande de nom n'a pas lieu d'être.
    $('identite').hidden = !autorise || Boolean(app.participant);
    $('zone-ecriture').hidden = !autorise || !app.participant;
    $('nom-participant').textContent = app.participant ?? '—';
    if (s?.ro) avis('Mode observateur : lecture seule.');
    else if (expire) avis('Session expirée : lecture et export restent possibles, écriture refusée.');
  }

  function afficherSante({ healthy, raison }) {
    $('sante').dataset.etat = healthy ? 'vert' : 'rouge';
    $('sante-texte').textContent = healthy ? 'bus : en service' : `bus : indisponible (${raison})`;
  }

  /**
   * L'indicateur vaut pour les deux écrans (AC-13) : dans le salon c'est le bus
   * du salon, à l'accueil celui que le champ propose de joindre — c'est là
   * qu'on le choisit, donc c'est là qu'il faut savoir s'il répond, avant de
   * créer une session sur un bus muet.
   */
  async function rafraichirSante() {
    if (app.salon) return afficherSante(await app.salon.sante());

    const base = sansSlash($('creer-serveur').value?.trim() || DEFAULT_NTFY_BASE);
    // Interroger un bus que la politique de sécurité bloquera ne dirait rien de
    // sa santé et laisserait une erreur réseau dans la console : on l'annonce
    // plutôt que de l'essayer. Aucune requête n'est encore partie vers ce bus,
    // contrairement au salon, qui y est déjà abonné.
    if (!busAutorise(base, adresse.origin)) {
      $('sante').dataset.etat = 'rouge';
      $('sante-texte').textContent = `bus : ${base} — refusé par la politique de sécurité de cette page`;
      return;
    }
    return afficherSante(await sonderSante({ base, fetchImpl }));
  }

  // ----------------------------------------------------------- accueil

  async function preparerAccueil() {
    montrer('accueil');
    $('creer-serveur').addEventListener('change', () => { app.pretSante = rafraichirSante(); });
    $('creer-form').addEventListener('submit', async (ev) => {
      ev.preventDefault?.();
      const nom = $('creer-nom').value.trim();
      const ttlH = Number($('creer-ttl').value);
      const serveur = sansSlash($('creer-serveur').value.trim() || DEFAULT_NTFY_BASE);

      if (!nom) return;
      if (!busAutorise(serveur, adresse.origin)) {
        $('aide-serveur').textContent = `Ce bus n'est pas joignable depuis cette page : la politique de sécurité n'autorise que ${BUS_AUTORISES.join(', ')}.`;
        return;
      }

      // On mémorise le nom du créateur : sans cela, l'ouverture du salon
      // rebasculerait sur l'écran d'identité, alors que le nom est déjà connu.
      memoire?.ecrire?.('nom', nom);

      const topic = generateTopic();
      const key = generateKey();
      const createdAt = now();
      const base = adresse.href.split('#')[0];
      const lien = buildSessionUrl({ topic, key, server: serveur, uiBase: base });

      const salon = fabriqueSalon({ topic, key, server: serveur, participant: nom, privateMeta: $('creer-prive').checked });
      await salon.demarrer({ onMessage: () => {} });
      await salon.annoncer({ ttlH, createdAt });
      salon.arreter();

      $('lien-participant').value = lien;
      $('lien-observateur').value = `${lien}&ro=1`;
      afficherQr(lien);
      $('creer-resultat').hidden = false;
      app.lienCree = lien;
    });

    for (const [bouton, champ] of [['copier-participant', 'lien-participant'], ['copier-observateur', 'lien-observateur']]) {
      $(bouton).addEventListener('click', () => presse?.ecrire?.($(champ).value));
    }
    $('ouvrir-salon').addEventListener('click', () => {
      adresse.href = app.lienCree;
      adresse.reload?.();
    });

    // Les écouteurs d'abord, l'attente ensuite : la page est déjà visible
    // pendant que le bus répond, et un formulaire soumis dans cette fenêtre
    // doit trouver son gestionnaire.
    await rafraichirSante();
    app.battement = minuteur.repeter(rafraichirSante, RAFRAICHIR_TTL_MS);
  }

  /**
   * Le code QR est posé en `data:` — la politique de sécurité l'autorise pour
   * les images et rien d'autre. Aucune ressource n'est chargée, aucun balisage
   * n'est injecté dans la page.
   */
  function afficherQr(lien) {
    const image = $('qr');
    try {
      const svg = versSvg(lien);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const cote = Number(svg.match(/width="(\d+)"/)?.[1] ?? 0);
      image.width = cote;
      image.height = cote;
      image.hidden = false;
    } catch (err) {
      // Un lien trop long pour un QR n'empêche pas de partager le lien lui-même.
      image.hidden = true;
      $('aide-serveur').textContent = `Code QR impossible : ${err.message}`;
    }
  }

  // ------------------------------------------------------------- salon

  async function preparerSalon({ topic, key, ro, server }) {
    montrer('salon');
    app.participant = ro ? null : (memoire?.lire?.('nom') ?? null);

    const salon = fabriqueSalon({ topic, key, server, ro, participant: app.participant, now });
    app.salon = salon;

    // Les listeners sont posés AVANT le premier `await` : sans cela, la page
    // reste visible pendant que la connexion se noue, et une soumission
    // pressée serait suivie de la navigation par défaut (bloquée par la CSP
    // form-action, donc muette) plutôt que du gestionnaire.
    $('identite').addEventListener('submit', (ev) => {
      ev.preventDefault?.();
      const nom = $('nom-champ').value.trim();
      if (!nom) return;
      app.participant = nom;
      salon.participant = nom;
      memoire?.ecrire?.('nom', nom);
      rafraichirEcriture();
      // On s'annonce pour que les autres sachent qui est là (§4). Un échec
      // n'empêche pas d'écrire : c'est une politesse, pas une condition.
      salon.annoncer().catch((err) => avis(`Annonce impossible : ${err.message}`));
    });

    $('zone-ecriture').addEventListener('submit', async (ev) => {
      ev.preventDefault?.();
      const texte = $('saisie').value.trim();
      if (!texte) return;
      try {
        await salon.envoyer(texte);
        $('saisie').value = '';
      } catch (err) {
        avis(err.message);
        rafraichirEcriture();
      }
    });

    $('exporter').addEventListener('click', async () => {
      const archive = await salon.exporter();
      telecharger?.(`${topic}.json`, JSON.stringify(archive, null, 2));
      avis(`${archive.messages.length} message(s) exportés, chiffrés.`);
    });

    $('importer').addEventListener('click', () => $('fichier-import').click?.());
    $('fichier-import').addEventListener('change', async () => {
      const contenu = await lireFichier?.($('fichier-import'));
      if (!contenu) return;
      try {
        const n = await salon.importer(JSON.parse(contenu), (v) => ajouterMessage(v));
        avis(`${n} message(s) relus depuis l'export.`);
      } catch (err) {
        avis(`Export illisible : ${err.message}`);
      }
    });

    $('etat-connexion').textContent = 'connexion…';
    await salon.demarrer({
      onMessage: (v) => { ajouterMessage(v); rafraichirEntete(); },
      onRoster: () => rafraichirEntete(),
      onEtat: ({ connecte, raison }) => {
        $('etat-connexion').textContent = connecte ? 'en direct' : `hors ligne — ${raison ?? 'reprise…'}`;
      },
      onMigration: (nouveau) => avis(`La session a migré vers ${nouveau} : le fil continue ici.`),
    });

    rafraichirEntete();
    await rafraichirSante();
    app.battement = minuteur.repeter(() => { rafraichirEntete(); rafraichirSante(); }, RAFRAICHIR_TTL_MS);
  }

  // ------------------------------------------------------------ erreur

  function preparerErreur(lecture) {
    montrer('erreur');
    $('erreur-titre').textContent = lecture.raison === 'cle-absente' ? 'Clé absente' : 'Lien invalide';
    $('erreur-message').textContent = lecture.message;
    // Rien du salon n'est monté : pas de fil, pas de zone d'écriture (AC-06).
    $('fil').replaceChildren();
    $('zone-ecriture').hidden = true;
  }

  // ------------------------------------------------------------ départ

  const lecture = lireFragment(adresse.hash);
  app.lecture = lecture;
  if (lecture.ok) app.pret = preparerSalon(lecture);
  else if (lecture.raison === 'accueil') app.pret = preparerAccueil();
  else { preparerErreur(lecture); app.pret = Promise.resolve(); }

  app.arreter = () => {
    if (app.battement !== undefined) minuteur.arreter(app.battement);
    app.salon?.arreter();
  };
  app.rafraichirEntete = rafraichirEntete;
  app.rafraichirSante = rafraichirSante;
  return app;
}

// Démarrage réel dans un navigateur. Sous Node, `document` n'existe pas et
// ce module reste un simple ensemble de fonctions, testable.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  demarrer({
    document,
    location: window.location,
    fenetre: window,
    presse: { ecrire: (t) => navigator.clipboard?.writeText(t) },
    memoire: {
      lire: (c) => { try { return window.localStorage.getItem(`agentchat:${c}`); } catch { return null; } },
      ecrire: (c, v) => { try { window.localStorage.setItem(`agentchat:${c}`, v); } catch { /* mode privé */ } },
    },
    telecharger: (nom, contenu) => {
      const url = URL.createObjectURL(new Blob([contenu], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = nom;
      a.click();
      URL.revokeObjectURL(url);
    },
    lireFichier: (input) => input.files?.[0]?.text() ?? null,
  });
}
