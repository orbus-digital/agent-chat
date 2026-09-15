/**
 * CLI `agentchat` — conçu pour être piloté par un agent : sortie JSON-lines
 * sur stdout, journal sur stderr, codes de retour stables.
 *
 *   0 ok · 2 usage · 3 droit d'écriture absent · 4 réseau · 5 intégrité
 *
 * `run()` est pur vis-à-vis du processus : tout ce qui touche au monde
 * (stdout, stderr, $HOME, horloge, réseau, système de fichiers) est injecté,
 * pour être éprouvé sans lancer de processus.
 */

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { generateKey, generateTopic, deriveWriteKey, IntegrityError } from './crypto.js';
import { encodeB64u, decodeB64u } from './bytes.js';
import { buildSessionUrl, parseSessionUrl, DEFAULT_UI_BASE } from './url.js';
import { normaliseServeur, UsageError, DEFAULT_NTFY_BASE } from './serveur.js';
import { saveSession, loadSession, sessionPath, normaliseTtl, isExpired, DEFAULT_TTL_H } from './session.js';
import { encodeMessage, decodeMessage, ReplayGuard, KINDS } from './protocol.js';
import { ouvrirDemande, preparerOctroi, lireOctroiPour, normaliserCode, formaterCode, sujetDe, VALIDITE_MS, AppairageError } from './appairage.js';
import { publish, poll, subscribe, NetworkError, LimitError } from './ntfy.js';
import { buildExport, decodeExport, readExport, ArchiveError } from './archive.js';

export const EXIT = { OK: 0, USAGE: 2, READONLY: 3, NETWORK: 4, INTEGRITY: 5 };
/** R5 : le CLI espace ses envois d'au moins 200 ms. */
export const MIN_SEND_INTERVAL_MS = 200;

/** Le pair n'a pas le droit d'écrire (mode observateur, ou session expirée). */
export class ReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyError';
    this.code = 'READONLY';
    this.exitCode = EXIT.READONLY;
  }
}

const USAGE = `agentchat — salon de conversation inter-agents, chiffré de bout en bout

  agentchat create  [--ttl H] [--as NOM] [--server URL] [--ui URL] [--private-meta]
                    [--allow-insecure]
  agentchat join    <url> --as <NOM> [--private-meta]
  agentchat tail    <url> [--since all|last|<id>] [--once] [--no-follow]
  agentchat send    <url> "<texte>" [--kind text|control] [--as NOM] [--private-meta]
  agentchat export  <url> [--since all|<id>]        > session.json
  agentchat replay  <fichier> [--url <url>]          (aucun réseau)
  agentchat migrate <url> [--as NOM]                 (control:migrate + nouveau topic)

Entrer sans faire voyager le lien — l'appairage (ADR-003) :
  agentchat pair      --as <NOM> [--server URL] [--ui URL] [--wait S]
                      côté demandeur : imprime un code, attend qu'on l'autorise
  agentchat authorize <url> <code>
                      côté membre : vérifie l'empreinte, scelle la clé de session

Le bus ntfy doit être en https:// : sur http://, les en-têtes X-Title et X-Tags
et le nom du topic voyagent en clair. --allow-insecure (ou AGENTCHAT_ALLOW_INSECURE=1)
lève le refus pour un serveur de test **sur la boucle locale seulement**.
Environnement : NTFY_BASE_URL (bus par défaut) · AGENTCHAT_UI_BASE (base des liens).

Codes de retour : 0 ok · 2 usage · 3 lecture seule ou TTL dépassé · 4 réseau · 5 intégrité`;

const OPTIONS = {
  ttl: { type: 'string' },
  as: { type: 'string' },
  server: { type: 'string' },
  ui: { type: 'string' },
  url: { type: 'string' },
  kind: { type: 'string' },
  since: { type: 'string' },
  wait: { type: 'string' },
  once: { type: 'boolean', default: false },
  'private-meta': { type: 'boolean', default: false },
  'no-follow': { type: 'boolean', default: false },
  'allow-insecure': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/**
 * @param {string[]} argv arguments après `agentchat`
 * @param {object} io { stdout, stderr, home, now, fetchImpl, sleep, readFile, uiBase, signal }
 * @returns {Promise<number>} code de retour
 */
export async function run(argv, io = {}) {
  const {
    stdout = (l) => process.stdout.write(`${l}\n`),
    stderr = (l) => process.stderr.write(`${l}\n`),
    home = homedir(),
    now = () => Date.now(),
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    readFile = (p) => readFileSync(p, 'utf8'),
    uiBase = process.env.AGENTCHAT_UI_BASE || DEFAULT_UI_BASE,
    // Spec §10 : le bus est configurable par l'environnement. Sans cette
    // lecture, `.env.example` documenterait une variable que rien ne lit.
    ntfyBase = process.env.NTFY_BASE_URL || DEFAULT_NTFY_BASE,
    // Consentement à un bus local en clair. Par l'environnement, il vaut pour
    // toute une session de mise au point ; par --allow-insecure, pour une
    // commande. Dans les deux cas, il ne vaut que pour la boucle locale.
    allowInsecure = process.env.AGENTCHAT_ALLOW_INSECURE === '1',
    // Les minuteurs sont injectés comme le reste du monde : une attente de cinq
    // minutes ne doit pas coûter cinq minutes à la suite de tests, et un
    // minuteur qu'on ne peut pas retirer garderait le processus en vie bien
    // après un appairage réussi.
    minuteur = { poser: (fn, ms) => setTimeout(fn, ms), retirer: (id) => clearTimeout(id) },
    signal,
  } = io;

  const ctx = { stdout, stderr, home: { home }, now, fetchImpl, sleep, readFile, uiBase, ntfyBase, allowInsecure, minuteur, signal };
  const log = (msg) => stderr(`[agentchat] ${msg}`);

  try {
    const commande = argv[0];
    if (!commande || commande === 'help' || commande === '--help' || commande === '-h') {
      stdout(USAGE);
      return commande ? EXIT.OK : EXIT.USAGE;
    }

    let values; let positionals;
    try {
      ({ values, positionals } = parseArgs({ args: argv.slice(1), options: OPTIONS, allowPositionals: true }));
    } catch (cause) {
      throw new UsageError(cause.message, { cause });
    }
    if (values.help) { stdout(USAGE); return EXIT.OK; }

    // `--ui` l'emporte sur AGENTCHAT_UI_BASE, qui l'emporte sur la base par
    // défaut. Posé ici plutôt que dans chaque commande : toute commande qui
    // imprimera une URL de session à l'avenir en héritera sans y penser.
    if (values.ui) ctx.uiBase = values.ui;
    if (values['allow-insecure']) ctx.allowInsecure = true;

    switch (commande) {
      case 'create': return await cmdCreate(values, ctx, log);
      case 'join': return await cmdJoin(values, positionals, ctx, log);
      case 'tail': return await cmdTail(values, positionals, ctx, log);
      case 'send': return await cmdSend(values, positionals, ctx, log);
      case 'export': return await cmdExport(values, positionals, ctx, log);
      case 'replay': return await cmdReplay(values, positionals, ctx, log);
      case 'migrate': return await cmdMigrate(values, positionals, ctx, log);
      case 'pair': return await cmdPair(values, ctx, log);
      case 'authorize': return await cmdAuthorize(values, positionals, ctx, log);
      default: throw new UsageError(`commande inconnue : ${commande}\n\n${USAGE}`);
    }
  } catch (err) {
    log(`erreur ${err.name ?? 'Error'} : ${err.message}`);
    return err.exitCode ?? EXIT.USAGE;
  }
}

// ---------------------------------------------------------------- create

async function cmdCreate(values, ctx, log) {
  const ttlH = normaliseTtl(values.ttl);
  // Précédence : --server, puis NTFY_BASE_URL, puis le bus public. La garde
  // s'applique aux trois — une variable d'environnement n'est pas un blanc-seing.
  const server = normaliseServeur(values.server ?? ctx.ntfyBase, { allowInsecure: ctx.allowInsecure });
  const participant = values.as ?? 'creator';
  const topic = generateTopic();
  const key = generateKey();
  const createdAt = ctx.now();

  const session = {
    topic, server, k: encodeB64u(key), participant, ro: false,
    privateMeta: values['private-meta'], lastId: null, ttlH, createdAt,
  };
  saveSession(session, ctx.home);
  log(`session écrite : ${sessionPath(topic, ctx.home)} (600)`);

  await publierRoster({ session, key, participants: [participant], ctx });
  log(`roster publié sur ${server}/${topic} (chiffré, TTL ${ttlH} h)`);
  if (session.privateMeta) log('métadonnées privées : le bus ne verra ni le nom des participants ni le kind');

  ctx.stdout(buildSessionUrl({ topic, key, server, uiBase: ctx.uiBase, allowInsecure: ctx.allowInsecure }));
  return EXIT.OK;
}

// ------------------------------------------------------------------ join

async function cmdJoin(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  if (!values.as) throw new UsageError('join : --as <nom> est requis');
  const { topic, key, ro, server } = parseSessionUrl(url, { allowInsecure: ctx.allowInsecure });

  const connue = tryLoad(topic, ctx);
  const vu = await dernierRoster({ topic, key, server, ctx });
  const roster = vu?.roster ?? null;
  if (!roster) {
    // Un roster tout juste publié n'est pas encore lisible : ntfy accuse
    // réception avant de servir le message dans son cache. Ce n'est pas grave
    // — chaque roster est cumulatif, et le suivant complètera la liste — mais
    // le taire donnerait à croire que la session est vide.
    log(connue
      ? 'aucun roster lisible sur le bus pour l’instant : la liste des présents sera complétée par le prochain'
      : 'aucun roster trouvé sur le bus (cache ntfy expiré ?)');
  }

  // Une durée de vie ne s'invente pas : celle qu'annonce le bus, sinon celle
  // qu'on connaissait déjà d'une visite précédente. À défaut, on en suppose une
  // **pour soi seul** — la supposition ne sera pas publiée.
  const duree = vu?.duree
    ?? (Number.isFinite(connue?.createdAt) ? { ttlH: connue.ttlH ?? DEFAULT_TTL_H, createdAt: connue.createdAt } : null);
  const ttlH = duree?.ttlH ?? DEFAULT_TTL_H;
  const createdAt = duree?.createdAt ?? ctx.now();
  if (!duree) {
    log(`durée de vie inconnue : ${DEFAULT_TTL_H} h supposées pour cette session locale, et rien d’annoncé aux autres`);
  }

  const session = {
    topic, server, k: encodeB64u(key), participant: values.as, ro,
    privateMeta: values['private-meta'] || Boolean(connue?.privateMeta),
    lastId: connue?.lastId ?? null, ttlH, createdAt, ttlSuppose: duree === null,
  };
  saveSession(session, ctx.home);
  log(`session écrite : ${sessionPath(topic, ctx.home)} (600)`);

  if (ro) {
    log('mode observateur : aucune annonce publiée, aucune écriture possible');
  } else if (isExpired(session, ctx.now())) {
    log('session expirée : rejointe en lecture seule');
  } else {
    const participants = [...new Set([...(roster?.meta?.participants ?? []), values.as])];
    await publierRoster({ session, key, participants, ctx });
    log(`roster publié (${participants.length} participant(s))`);
  }

  ctx.stdout(JSON.stringify({
    topic, server, participant: values.as, ro,
    ttlH, expiresAt: createdAt + ttlH * 3600_000,
    expired: isExpired(session, ctx.now()),
  }));
  return EXIT.OK;
}

// ------------------------------------------------------------------ tail

/**
 * Lit un topic, et **suit** un ordre de migration : un `control:migrate`
 * vérifié fait basculer la lecture sur le nouveau topic, depuis son début,
 * de sorte qu'aucun message publié après l'ordre ne soit perdu (AC-16).
 */
async function cmdTail(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  const { topic, key, server } = parseSessionUrl(url, { allowInsecure: ctx.allowInsecure });
  const kw = await deriveWriteKey(key);
  const connue = tryLoad(topic, ctx);

  const garde = new ReplayGuard();
  const lecteur = new LecteurDeFil({ key, kw, garde, ctx, log });

  let topicCourant = topic;
  let since = resoudreSince(values.since, connue);
  let dernierId = connue?.lastId ?? null;
  const suivre = !values['no-follow'];

  // Une migration relance la boucle sur le nouveau topic ; sans migration,
  // la boucle ne fait qu'un tour.
  for (;;) {
    lecteur.topic = topicCourant;
    lecteur.migration = null;

    if (values.once) {
      for (const raw of await poll({ base: server, topic: topicCourant, since, fetchImpl: ctx.fetchImpl, signal: ctx.signal })) {
        await lecteur.traiter(raw);
        if (lecteur.migration && suivre) break;
      }
    } else {
      await new Promise((resolve, reject) => {
        const arret = subscribe({
          base: server, topic: topicCourant, since, fetchImpl: ctx.fetchImpl, signal: ctx.signal,
          onMessage: (raw) => lecteur.enfiler(raw, () => { arret(); resolve(); }, (e) => { arret(); reject(e); }),
          onError: (e) => log(`flux interrompu, reprise en cours : ${e.message}`),
        });
        if (ctx.signal) ctx.signal.addEventListener('abort', () => { arret(); resolve(); }, { once: true });
      });
      await lecteur.repos();
    }

    dernierId = lecteur.dernierId ?? dernierId;
    if (!(lecteur.migration && suivre)) break;

    log(`migration vers ${lecteur.migration} : reprise du fil sur le nouveau topic`);
    topicCourant = lecteur.migration;
    since = 'all';
  }

  if (connue && dernierId && dernierId !== connue.lastId && topicCourant === topic) {
    saveSession({ ...connue, lastId: dernierId }, ctx.home);
  }
  return lecteur.integriteRompue ? EXIT.INTEGRITY : EXIT.OK;
}

/**
 * Sérialise le traitement des messages d'un flux : le déchiffrement est
 * asynchrone, or les messages arrivent d'un rappel synchrone. Sans file, deux
 * messages proches se déchiffreraient en parallèle et pourraient s'afficher
 * dans le désordre — ou traverser le garde-fou anti-rejeu à contretemps.
 */
class LecteurDeFil {
  constructor({ key, kw, garde, ctx, log }) {
    Object.assign(this, { key, kw, garde, ctx, log });
    this.topic = null;
    this.migration = null;
    this.dernierId = null;
    this.integriteRompue = false;
    this.file = Promise.resolve();
  }

  enfiler(raw, onMigration, onErreur) {
    this.file = this.file
      .then(() => this.traiter(raw))
      .then(() => { if (this.migration) onMigration(); })
      .catch(onErreur);
  }

  repos() { return this.file; }

  async traiter(raw) {
    let m;
    try {
      m = await decodeMessage({ key: this.key, kw: this.kw, topic: this.topic, raw });
    } catch (err) {
      if (!(err instanceof IntegrityError)) throw err;
      this.integriteRompue = true;
      this.log(`intégrité invalide sur le message ${raw?.id ?? '?'} : ${err.message}`);
      // Rien de partiel : ni texte, ni auteur présumé authentique (AC-05).
      this.ctx.stdout(JSON.stringify({ id: raw?.id ?? null, integrity: 'invalid', verified: false }));
      if (raw?.id) this.dernierId = raw.id;
      return;
    }
    if (m === null) return; // événement de service ntfy

    const { duplicate, outOfOrder } = this.garde.check({ nonce: m.nonce, ts: m.ts });
    if (duplicate) { this.log(`doublon ignoré : ${m.id}`); return; }
    if (outOfOrder) this.log(`rupture d'ordre détectée sur ${m.id} (horodatage en recul de plus de 60 s)`);

    this.dernierId = m.id;
    this.ctx.stdout(JSON.stringify({
      id: m.id, ts: m.ts, from: m.from, kind: m.kind, text: m.text, verified: m.verified,
      ...(m.meta === undefined ? {} : { meta: m.meta }),
      ...(outOfOrder ? { outOfOrder: true } : {}),
    }));

    // Un ordre de migration non vérifié n'en est pas un : il suffirait sinon de
    // connaître le nom du topic pour détourner tout le salon.
    if (m.kind === 'control' && m.meta?.type === 'migrate' && m.verified && typeof m.meta.topic === 'string') {
      this.migration = m.meta.topic;
    }
  }
}

// ------------------------------------------------------------------ send

async function cmdSend(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  const texte = positionals[1];
  if (texte === undefined) throw new UsageError('send : texte du message attendu');

  const kind = values.kind ?? 'text';
  if (!KINDS.includes(kind)) throw new UsageError(`--kind : ${KINDS.join('|')} attendu (reçu « ${kind} »)`);

  const { topic, key, ro, server } = parseSessionUrl(url, { allowInsecure: ctx.allowInsecure });
  const connue = tryLoad(topic, ctx);
  const participant = exigerDroitDEcriture({ ro, connue, values, ctx });

  // R5 : au moins 200 ms entre deux envois, y compris entre deux invocations.
  if (connue?.lastSendAt) {
    const reste = MIN_SEND_INTERVAL_MS - (ctx.now() - connue.lastSendAt);
    if (reste > 0) await ctx.sleep(reste);
  }

  const env = await encodeMessage({
    key, kw: await deriveWriteKey(key), topic, from: participant, kind, text: texte, ts: ctx.now(),
    privateMeta: values['private-meta'] || Boolean(connue?.privateMeta),
  });
  const publie = await publish({
    base: server, topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });

  if (connue) saveSession({ ...connue, lastSendAt: ctx.now() }, ctx.home);
  log(`message publié (${env.body.length} octets chiffrés)`);
  ctx.stdout(JSON.stringify({ id: publie.id, ts: env.ts, from: participant, kind, sent: true }));
  return EXIT.OK;
}

// ---------------------------------------------------------------- export

async function cmdExport(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  const { topic, server } = parseSessionUrl(url, { allowInsecure: ctx.allowInsecure });

  const messages = await poll({
    base: server, topic, since: values.since ?? 'all', fetchImpl: ctx.fetchImpl, signal: ctx.signal,
  });
  const archive = buildExport({ topic, server, messages, exportedAt: ctx.now() });
  log(`${archive.messages.length} message(s) exporté(s), chiffrés — relisibles avec la clé de session`);
  ctx.stdout(JSON.stringify(archive, null, 2));
  return EXIT.OK;
}

// ---------------------------------------------------------------- replay

/** Ne touche jamais au réseau : c'est la garantie que porte AC-09. */
async function cmdReplay(values, positionals, ctx, log) {
  const chemin = positionals[0];
  if (!chemin) throw new UsageError('replay : chemin du fichier d\'export attendu');

  let archive;
  try {
    archive = JSON.parse(ctx.readFile(chemin));
  } catch (cause) {
    throw new ArchiveError(`export illisible : ${chemin} (${cause.message})`, { cause });
  }

  // La forme du fichier est jugée avant qu'on cherche une clé : un fichier qui
  // n'est pas un export doit être refusé pour ce qu'il est, pas pour une clé
  // manquante qui n'aurait de toute façon rien ouvert.
  readExport(archive);
  const key = cleDeRelecture({ archive, values, ctx });
  const messages = await decodeExport({ key, exportObj: archive });

  let integriteRompue = false;
  for (const m of messages) {
    if (m.integrity === 'invalid') {
      integriteRompue = true;
      log(`intégrité invalide sur le message ${m.id ?? '?'} : ${m.reason}`);
      ctx.stdout(JSON.stringify({ id: m.id, integrity: 'invalid', verified: false }));
      continue;
    }
    ctx.stdout(JSON.stringify({
      id: m.id, ts: m.ts, from: m.from, kind: m.kind, text: m.text, verified: m.verified,
      ...(m.meta === undefined ? {} : { meta: m.meta }),
    }));
  }
  log(`${messages.length} message(s) relus depuis ${chemin}, sans réseau`);
  return integriteRompue ? EXIT.INTEGRITY : EXIT.OK;
}

/** La clé vient de l'URL fournie, sinon du fichier de session local. */
function cleDeRelecture({ archive, values, ctx }) {
  if (values.url) {
    const { topic, key } = parseSessionUrl(values.url, { allowInsecure: ctx.allowInsecure });
    if (topic !== archive.topic) throw new UsageError(`l'URL porte le topic ${topic}, l'export porte ${archive.topic}`);
    return key;
  }
  const connue = tryLoad(archive.topic, ctx);
  if (!connue?.k) {
    throw new UsageError(
      `clé introuvable pour ${archive.topic} : passez --url "<url de session>" ou rejoignez d'abord la session`,
    );
  }
  return decodeB64u(connue.k);
}

// --------------------------------------------------------------- migrate

/**
 * Change de topic sans changer de clé : ce que la migration soigne, c'est un
 * **nom de topic** connu de trop de monde (bruit, déni de service), pas une
 * clé compromise — la clé, elle, n'a jamais quitté les fragments d'URL.
 */
async function cmdMigrate(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  const { topic, key, ro, server, uiBase } = parseSessionUrl(url, { allowInsecure: ctx.allowInsecure });
  const connue = tryLoad(topic, ctx);
  const participant = exigerDroitDEcriture({ ro, connue, values, ctx });

  const nouveau = generateTopic();
  const kw = await deriveWriteKey(key);
  const ttlH = connue?.ttlH ?? DEFAULT_TTL_H;
  const createdAt = connue?.createdAt ?? ctx.now();

  const ordre = await encodeMessage({
    key, kw, topic, from: participant, kind: 'control', text: 'migrate',
    meta: { type: 'migrate', topic: nouveau, ttlH, createdAt }, ts: ctx.now(),
    privateMeta: Boolean(connue?.privateMeta),
  });
  await publish({
    base: server, topic, body: ordre.body, title: ordre.title, tags: ordre.tags, sig: ordre.sig,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });
  log(`control:migrate publié sur l'ancien topic (${topic})`);

  const session = {
    topic: nouveau, server, k: encodeB64u(key), participant, ro: false,
    privateMeta: Boolean(connue?.privateMeta), lastId: null, ttlH, createdAt,
    // Une durée supposée le reste après la migration : le nouveau topic hérite
    // du salon, y compris de ce qu'on n'en sait pas.
    ttlSuppose: Boolean(connue?.ttlSuppose) || !Number.isFinite(connue?.createdAt),
  };
  saveSession(session, ctx.home);
  await publierRoster({ session, key, participants: [participant], ctx });
  log(`roster publié sur le nouveau topic (${nouveau})`);

  // Précédence : `--ui` explicite d'abord, puis la base de l'URL migrée — on
  // reste sur l'interface d'où l'on vient —, puis la base par défaut.
  ctx.stdout(buildSessionUrl({ topic: nouveau, key, server, uiBase: values.ui ?? uiBase ?? ctx.uiBase, allowInsecure: ctx.allowInsecure }));
  return EXIT.OK;
}

// ------------------------------------------------- pair / authorize (ADR-003)

/**
 * Côté **demandeur**. Génère une paire éphémère, publie sa clé publique sur le
 * sujet dérivé du code, imprime le code, et attend qu'un membre du salon scelle
 * la clé de session à son intention.
 *
 * Le code n'est pas un secret à deviner : c'est l'**empreinte** de la clé
 * publique qu'on vient de publier. Un adversaire qui substituerait sa propre clé
 * changerait l'empreinte, donc le code — et le membre refuserait.
 */
async function cmdPair(values, ctx, log) {
  // Exigé avant tout effet de bord : on n'ouvre pas un rendez-vous pour
  // s'apercevoir ensuite qu'on ne saura pas sous quel nom entrer.
  if (!values.as) throw new UsageError('pair : --as <nom> est requis — c\'est le nom sous lequel vous entrerez dans le salon');
  const server = normaliseServeur(values.server ?? ctx.ntfyBase, { allowInsecure: ctx.allowInsecure });

  const demande = await ouvrirDemande({ ts: ctx.now() });
  await publish({
    base: server, topic: demande.sujet, body: demande.offre.body,
    title: demande.offre.title, tags: demande.offre.tags,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });

  ctx.stdout(JSON.stringify({
    code: demande.code, display: demande.codeLisible, topic: demande.sujet,
    expiresAt: demande.expiresAt, waiting: true,
  }));
  log(`Code : ${demande.codeLisible} — à dicter à un membre du salon, qui le saisira chez lui.`);
  log(`Valable ${VALIDITE_MS / 60_000} minutes, à usage unique. Le code voyage en clair : dictez-le par un canal de confiance.`);

  const attenteMs = dureeDAttente(values.wait, demande.expiresAt - ctx.now());
  const invitation = await attendreOctroi({ demande, server, attenteMs, ctx, log });
  if (!invitation) {
    throw new ReadOnlyError(
      `code ${demande.codeLisible} expiré : personne ne l'a autorisé dans le délai. Relancez « agentchat pair » pour un code neuf`,
    );
  }

  return await entrerParInvitation({ invitation, participant: values.as, ctx, log });
}

/** Le délai d'attente : `--wait` en secondes, sinon ce qu'il reste au code. */
function dureeDAttente(brut, reste) {
  if (brut === undefined) return Math.max(0, reste);
  const s = Number(brut);
  if (!Number.isFinite(s) || s <= 0) throw new UsageError(`--wait : un nombre de secondes positif attendu (reçu « ${brut} »)`);
  return s * 1000;
}

/**
 * Attend sur le sujet d'appairage jusqu'à l'octroi, ou jusqu'à l'échéance.
 *
 * Un octroi qui nous vise mais ne s'ouvre pas est **signalé et ignoré** : il
 * suffirait sinon à un adversaire de publier un chiffré quelconque pour empêcher
 * l'appairage légitime d'aboutir.
 *
 * @returns {Promise<object|null>} l'invitation ouverte, ou `null` à l'échéance.
 */
function attendreOctroi({ demande, server, attenteMs, ctx, log }) {
  return new Promise((resolve, reject) => {
    let fini = false;
    let echeance;
    const terminer = (valeur) => {
      if (fini) return;
      fini = true;
      ctx.minuteur.retirer(echeance);
      arret();
      resolve(valeur);
    };

    const arret = subscribe({
      base: server, topic: demande.sujet, since: 'all',
      fetchImpl: ctx.fetchImpl, signal: ctx.signal,
      onMessage: (raw) => {
        if (fini) return;
        lireOctroiPour({ demande, raw })
          .then((invitation) => { if (invitation) terminer(invitation); })
          .catch((err) => {
            if (err instanceof IntegrityError) {
              log(`octroi illisible ignoré (clé substituée ou chiffré altéré) : ${err.message}`);
              return;
            }
            if (!fini) { fini = true; ctx.minuteur.retirer(echeance); arret(); reject(err); }
          });
      },
      onError: (e) => log(`flux du rendez-vous interrompu, reprise en cours : ${e.message}`),
    });

    echeance = ctx.minuteur.poser(() => terminer(null), attenteMs);
    ctx.signal?.addEventListener?.('abort', () => terminer(null), { once: true });
  });
}

/**
 * Écrit la session reçue et s'annonce, exactement comme `join` le ferait — un
 * appairage réussi doit laisser le poste dans le même état qu'un lien suivi.
 */
async function entrerParInvitation({ invitation, participant, ctx, log }) {
  const key = decodeB64u(invitation.k);
  // Le serveur vient d'un tiers : c'est le même vecteur que le paramètre `s`
  // d'un lien de session, et il passe la même garde. Personne ne nous fait
  // retomber en clair parce qu'on a saisi un code.
  const server = normaliseServeur(invitation.server, { allowInsecure: ctx.allowInsecure, quoi: 'serveur ntfy de l\'invitation' });

  const connue = Number.isFinite(invitation.ttlH) && Number.isFinite(invitation.createdAt);
  const session = {
    topic: invitation.topic, server, k: invitation.k, participant, ro: false,
    privateMeta: Boolean(invitation.privateMeta),
    lastId: null,
    ttlH: connue ? invitation.ttlH : DEFAULT_TTL_H,
    createdAt: connue ? invitation.createdAt : ctx.now(),
    // Même règle qu'à `join` (R4, D-09) : une durée qu'on ignore est supposée
    // pour soi seul, jamais annoncée aux autres.
    ttlSuppose: !connue,
  };
  saveSession(session, ctx.home);
  log(`appairage accepté : session écrite dans ${sessionPath(session.topic, ctx.home)} (600)`);
  if (!connue) log(`durée de vie inconnue : ${DEFAULT_TTL_H} h supposées pour cette session locale, et rien d’annoncé aux autres`);

  if (isExpired(session, ctx.now())) {
    log('session expirée : rejointe en lecture seule');
  } else {
    const participants = [...new Set([...(invitation.participants ?? []), participant])];
    await publierRoster({ session, key, participants, ctx });
    log(`roster publié (${participants.length} participant(s))`);
  }

  ctx.stdout(buildSessionUrl({
    topic: session.topic, key, server, uiBase: ctx.uiBase, allowInsecure: ctx.allowInsecure,
  }));
  return EXIT.OK;
}

/**
 * Côté **membre**. Saisit un code, relit la clé publique publiée sur le sujet
 * qu'il dérive, **vérifie que son empreinte est exactement ce code**, puis
 * publie la clé de session scellée pour cette clé.
 *
 * Le refus est la partie utile : substitution de clé (code 5), code périmé ou
 * déjà consommé (code 3), code mal saisi (code 2). Aucun de ces refus ne publie
 * quoi que ce soit.
 */
async function cmdAuthorize(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  if (positionals[1] === undefined) throw new UsageError('authorize : le code d\'appairage est attendu (par exemple KXR7-2M4Q-9T)');
  const code = normaliserCode(positionals[1]);

  const { topic, key, ro, server } = parseSessionUrl(url, { allowInsecure: ctx.allowInsecure });
  const connue = tryLoad(topic, ctx);
  // Autoriser, c'est donner le droit d'écrire : un observateur ne le détient
  // pas et ne peut donc pas le transmettre. Et on n'invite personne dans un
  // salon qui a dépassé sa durée de vie.
  if (ro || connue?.ro) throw new ReadOnlyError('mode observateur : autoriser un agent est refusé (l\'URL porte ro=1)');
  if (connue && isExpired(connue, ctx.now())) {
    throw new ReadOnlyError(`session expirée (TTL ${connue.ttlH} h) : aucun agent ne peut plus y être admis`);
  }

  const sujet = await sujetDe(code);
  const messages = await poll({ base: server, topic: sujet, since: 'all', fetchImpl: ctx.fetchImpl, signal: ctx.signal });

  const { octroi } = await preparerOctroi({
    code, messages, maintenant: ctx.now(),
    invitation: await invitationDuSalon({ topic, key, server, connue, ctx }),
  });
  await publish({
    base: server, topic: sujet, body: octroi.body, title: octroi.title, tags: octroi.tags,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });

  log(`code ${formaterCode(code)} autorisé : la clé de session a été scellée pour cette clé publique, et pour elle seule`);
  ctx.stdout(JSON.stringify({ code, topic, granted: true }));
  return EXIT.OK;
}

/**
 * Ce qu'un membre a le droit de transmettre : de quoi écrire une session
 * complète. La durée de vie n'en fait partie que si elle est **connue** — d'un
 * roster annoncé sur le bus, ou d'une session locale qui ne l'a pas supposée.
 * Sinon elle est omise, et l'arrivant la supposera pour lui seul (R4, D-09).
 */
async function invitationDuSalon({ topic, key, server, connue, ctx }) {
  const vu = await dernierRoster({ topic, key, server, ctx });
  const duree = vu?.duree
    ?? (connue && !connue.ttlSuppose && Number.isFinite(connue.createdAt)
      ? { ttlH: connue.ttlH ?? DEFAULT_TTL_H, createdAt: connue.createdAt }
      : null);

  return {
    topic, server, k: encodeB64u(key),
    privateMeta: Boolean(connue?.privateMeta),
    participants: vu?.roster?.meta?.participants ?? [],
    ...(duree ? { ttlH: duree.ttlH, createdAt: duree.createdAt } : {}),
  };
}

// ----------------------------------------------------------------- outils

function requireUrl(positionals) {
  const url = positionals[0];
  if (!url) throw new UsageError('URL de session attendue');
  return url;
}

/**
 * R7 et R4 réunis : on n'écrit ni en mode observateur, ni au-delà du TTL.
 * @returns {string} le nom du participant sous lequel écrire
 */
function exigerDroitDEcriture({ ro, connue, values, ctx }) {
  if (ro || connue?.ro) throw new ReadOnlyError("mode observateur : écriture refusée (l'URL porte ro=1)");

  const participant = values.as ?? connue?.participant;
  if (!participant) throw new UsageError("--as <nom> requis tant que la session n'a pas été rejointe");

  if (connue && isExpired(connue, ctx.now())) {
    throw new ReadOnlyError(
      `session expirée (TTL ${connue.ttlH} h) : écriture refusée, lecture et export restent possibles`,
    );
  }
  return participant;
}

function tryLoad(topic, ctx) {
  try {
    return loadSession(topic, ctx.home);
  } catch {
    return null;
  }
}

function resoudreSince(demande, connue) {
  if (!demande || demande === 'all') return demande === 'all' ? 'all' : (connue?.lastId ?? 'all');
  if (demande === 'last') return connue?.lastId ?? 'all';
  return demande;
}

async function publierRoster({ session, key, participants, ctx }) {
  const env = await encodeMessage({
    key, kw: await deriveWriteKey(key), topic: session.topic, from: session.participant, kind: 'control',
    text: 'roster',
    // Une durée de vie **supposée** n'est pas annoncée : sinon un arrivant qui
    // n'a pas pu lire le roster la redéfinirait pour tout le monde, et une
    // session créée pour 2 h deviendrait une session de 24 h (R4). Un roster
    // muet sur la durée ajoute un présent, il n'efface rien.
    meta: session.ttlSuppose
      ? { type: 'roster', participants }
      : {
        type: 'roster', participants, ttlH: session.ttlH, createdAt: session.createdAt,
        expiresAt: session.createdAt + session.ttlH * 3600_000,
      },
    ts: ctx.now(),
    privateMeta: Boolean(session.privateMeta),
  });
  return publish({
    base: session.server, topic: session.topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });
}

/**
 * Ce que le bus dit de la session : le dernier `control:roster` lisible, et la
 * dernière durée de vie **annoncée** — qui peut venir d'un roster plus ancien,
 * un arrivant n'ayant pas à redéfinir la durée du salon qu'il rejoint. Sans
 * cette distinction, un seul roster muet effacerait la durée pour tous ceux
 * qui arrivent ensuite.
 *
 * @returns {Promise<{roster:object, duree:{ttlH:number, createdAt:number}|null}|null>}
 */
async function dernierRoster({ topic, key, server, ctx }) {
  const kw = await deriveWriteKey(key);
  let messages;
  try {
    messages = await poll({ base: server, topic, since: 'all', fetchImpl: ctx.fetchImpl, signal: ctx.signal });
  } catch {
    return null; // pas de roster lisible : l'appelant décide quoi en faire
  }
  let roster = null;
  let duree = null;
  for (const raw of messages.reverse()) {
    let m;
    try {
      m = await decodeMessage({ key, kw, topic, raw });
    } catch { continue; /* un message illisible n'est pas un roster */ }
    if (m?.kind !== 'control' || m.meta?.type !== 'roster') continue;
    roster ??= m;
    if (duree === null && Number.isFinite(m.meta.ttlH) && Number.isFinite(m.meta.createdAt)) {
      duree = { ttlH: m.meta.ttlH, createdAt: m.meta.createdAt };
    }
    if (roster && duree) break;
  }
  return roster ? { roster, duree } : null;
}

export { USAGE, NetworkError, LimitError, UsageError, IntegrityError, ArchiveError, AppairageError };
