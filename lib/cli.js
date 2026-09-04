/**
 * CLI `agentchat` — conçu pour être piloté par un agent : sortie JSON-lines
 * sur stdout, journal sur stderr, codes de retour stables.
 *
 *   0 ok · 2 usage · 3 droit d'écriture absent · 4 réseau · 5 intégrité
 *
 * `run()` est pur vis-à-vis du processus : tout ce qui touche au monde
 * (stdout, stderr, $HOME, horloge, réseau) est injecté, pour être éprouvé
 * sans lancer de processus.
 */

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { generateKey, generateTopic, deriveWriteKey, IntegrityError } from './crypto.js';
import { encodeB64u } from './base64url.js';
import { buildSessionUrl, parseSessionUrl, UsageError, DEFAULT_NTFY_BASE, DEFAULT_UI_BASE } from './url.js';
import { saveSession, loadSession, sessionPath, normaliseTtl, isExpired, DEFAULT_TTL_H } from './session.js';
import { encodeMessage, decodeMessage, ReplayGuard, KINDS } from './protocol.js';
import { publish, poll, subscribe, NetworkError, LimitError } from './ntfy.js';

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

  agentchat create [--ttl H] [--as NOM] [--server URL] [--ui URL]
  agentchat join   <url> --as <NOM>
  agentchat tail   <url> [--as NOM] [--since all|last|<id>] [--once]
  agentchat send   <url> "<texte>" [--kind text|control] [--as NOM]

Codes de retour : 0 ok · 2 usage · 3 lecture seule · 4 réseau · 5 intégrité`;

const OPTIONS = {
  ttl: { type: 'string' },
  as: { type: 'string' },
  server: { type: 'string' },
  ui: { type: 'string' },
  kind: { type: 'string' },
  since: { type: 'string' },
  once: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/**
 * @param {string[]} argv arguments après `agentchat`
 * @param {object} io { stdout, stderr, home, now, fetchImpl, sleep, uiBase, signal }
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
    uiBase = process.env.AGENTCHAT_UI_BASE || DEFAULT_UI_BASE,
    signal,
  } = io;

  const ctx = { stdout, stderr, home: { home }, now, fetchImpl, sleep, uiBase, signal };
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

    switch (commande) {
      case 'create': return await cmdCreate(values, ctx, log);
      case 'join': return await cmdJoin(values, positionals, ctx, log);
      case 'tail': return await cmdTail(values, positionals, ctx, log);
      case 'send': return await cmdSend(values, positionals, ctx, log);
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
  const server = (values.server ?? DEFAULT_NTFY_BASE).replace(/\/+$/, '');
  const participant = values.as ?? 'creator';
  const topic = generateTopic();
  const key = generateKey();
  const createdAt = ctx.now();

  const session = { topic, server, k: encodeB64u(key), participant, ro: false, lastId: null, ttlH, createdAt };
  saveSession(session, ctx.home);
  log(`session écrite : ${sessionPath(topic, ctx.home)} (600)`);

  await publierRoster({ session, key, participants: [participant], ctx });
  log(`roster publié sur ${server}/${topic} (chiffré, TTL ${ttlH} h)`);

  ctx.stdout(buildSessionUrl({ topic, key, server, uiBase: ctx.uiBase }));
  return EXIT.OK;
}

// ------------------------------------------------------------------ join

async function cmdJoin(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  if (!values.as) throw new UsageError('join : --as <nom> est requis');
  const { topic, key, ro, server } = parseSessionUrl(url);

  const connue = tryLoad(topic, ctx);
  const roster = await dernierRoster({ topic, key, server, ctx });
  if (!roster && !connue) log('aucun roster trouvé sur le bus : la durée de vie ne peut être confirmée (cache ntfy expiré ?)');

  const ttlH = roster?.meta?.ttlH ?? connue?.ttlH ?? DEFAULT_TTL_H;
  const createdAt = roster?.meta?.createdAt ?? connue?.createdAt ?? ctx.now();

  const session = {
    topic, server, k: encodeB64u(key), participant: values.as, ro,
    lastId: connue?.lastId ?? null, ttlH, createdAt,
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

async function cmdTail(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  const { topic, key, server } = parseSessionUrl(url);
  const kw = deriveWriteKey(key);
  const connue = tryLoad(topic, ctx);

  const since = resoudreSince(values.since, connue);
  const garde = new ReplayGuard();
  let integriteRompue = false;
  let dernierId = connue?.lastId ?? null;

  const traiter = (raw) => {
    let m;
    try {
      m = decodeMessage({ key, kw, topic, raw });
    } catch (err) {
      if (!(err instanceof IntegrityError)) throw err;
      integriteRompue = true;
      log(`intégrité invalide sur le message ${raw?.id ?? '?'} : ${err.message}`);
      // Rien de partiel : ni texte, ni auteur présumé authentique (AC-05).
      ctx.stdout(JSON.stringify({ id: raw?.id ?? null, integrity: 'invalid', verified: false }));
      if (raw?.id) dernierId = raw.id;
      return;
    }
    if (m === null) return; // événement de service ntfy

    const { duplicate, outOfOrder } = garde.check({ nonce: m.nonce, ts: m.ts });
    if (duplicate) { log(`doublon ignoré : ${m.id}`); return; }
    if (outOfOrder) log(`rupture d'ordre détectée sur ${m.id} (horodatage en recul de plus de 60 s)`);

    dernierId = m.id;
    ctx.stdout(JSON.stringify({
      id: m.id, ts: m.ts, from: m.from, kind: m.kind, text: m.text, verified: m.verified,
      ...(m.meta === undefined ? {} : { meta: m.meta }),
      ...(outOfOrder ? { outOfOrder: true } : {}),
    }));
  };

  if (values.once) {
    for (const raw of await poll({ base: server, topic, since, fetchImpl: ctx.fetchImpl, signal: ctx.signal })) traiter(raw);
  } else {
    await new Promise((resolve, reject) => {
      const arret = subscribe({
        base: server, topic, since, fetchImpl: ctx.fetchImpl, signal: ctx.signal,
        onMessage: (raw) => { try { traiter(raw); } catch (e) { arret(); reject(e); } },
        onError: (e) => log(`flux interrompu, reprise en cours : ${e.message}`),
      });
      if (ctx.signal) ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  if (connue && dernierId && dernierId !== connue.lastId) saveSession({ ...connue, lastId: dernierId }, ctx.home);
  return integriteRompue ? EXIT.INTEGRITY : EXIT.OK;
}

// ------------------------------------------------------------------ send

async function cmdSend(values, positionals, ctx, log) {
  const url = requireUrl(positionals);
  const texte = positionals[1];
  if (texte === undefined) throw new UsageError('send : texte du message attendu');

  const kind = values.kind ?? 'text';
  if (!KINDS.includes(kind)) throw new UsageError(`--kind : ${KINDS.join('|')} attendu (reçu « ${kind} »)`);

  const { topic, key, ro, server } = parseSessionUrl(url);
  const connue = tryLoad(topic, ctx);

  if (ro || connue?.ro) throw new ReadOnlyError('mode observateur : écriture refusée (l\'URL porte ro=1)');

  const participant = values.as ?? connue?.participant;
  if (!participant) throw new UsageError('send : --as <nom> requis tant que la session n\'a pas été rejointe');

  if (connue && isExpired(connue, ctx.now())) {
    throw new ReadOnlyError(`session expirée (TTL ${connue.ttlH} h) : écriture refusée, lecture de l'archive toujours possible`);
  }

  // R5 : au moins 200 ms entre deux envois, y compris entre deux invocations.
  if (connue?.lastSendAt) {
    const reste = MIN_SEND_INTERVAL_MS - (ctx.now() - connue.lastSendAt);
    if (reste > 0) await ctx.sleep(reste);
  }

  const env = encodeMessage({
    key, kw: deriveWriteKey(key), topic, from: participant, kind, text: texte, ts: ctx.now(),
  });
  const publie = await publish({
    base: server, topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });

  if (connue) saveSession({ ...connue, lastSendAt: ctx.now() }, ctx.home);
  log(`message publié (${Buffer.byteLength(env.body)} octets chiffrés)`);
  ctx.stdout(JSON.stringify({ id: publie.id, ts: env.ts, from: participant, kind, sent: true }));
  return EXIT.OK;
}

// ----------------------------------------------------------------- outils

function requireUrl(positionals) {
  const url = positionals[0];
  if (!url) throw new UsageError('URL de session attendue');
  return url;
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
  const env = encodeMessage({
    key, kw: deriveWriteKey(key), topic: session.topic, from: session.participant, kind: 'control',
    text: 'roster',
    meta: {
      type: 'roster', participants, ttlH: session.ttlH, createdAt: session.createdAt,
      expiresAt: session.createdAt + session.ttlH * 3600_000,
    },
    ts: ctx.now(),
  });
  return publish({
    base: session.server, topic: session.topic, body: env.body, title: env.title, tags: env.tags, sig: env.sig,
    fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, signal: ctx.signal,
  });
}

/** Dernier `control:roster` lisible sur le bus, ou null. */
async function dernierRoster({ topic, key, server, ctx }) {
  const kw = deriveWriteKey(key);
  let messages;
  try {
    messages = await poll({ base: server, topic, since: 'all', fetchImpl: ctx.fetchImpl, signal: ctx.signal });
  } catch {
    return null; // pas de roster lisible : l'appelant décide quoi en faire
  }
  for (const raw of messages.reverse()) {
    try {
      const m = decodeMessage({ key, kw, topic, raw });
      if (m?.kind === 'control' && m.meta?.type === 'roster') return m;
    } catch { /* un message illisible n'est pas un roster */ }
  }
  return null;
}

export { USAGE, NetworkError, LimitError, UsageError, IntegrityError };
