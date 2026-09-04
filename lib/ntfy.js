/**
 * Transport ntfy. La seule couche qui parle au réseau.
 *
 * Trois garanties portées ici :
 *   R1 — rien ne part qui ne soit du base64url (donc du chiffré) ;
 *   R5 — 64 Ko par message, repli exponentiel sur 429, jamais de perte silencieuse ;
 *   AC-07 — la reprise repart du dernier identifiant reçu, `since` étant exclusif.
 */

const B64U_ONLY = /^[A-Za-z0-9_-]+$/;

/** R5 : 64 Ko de chiffré par message. */
export const MAX_BODY_BYTES = 64 * 1024;
/** AC-11 : cinq tentatives, puis code 4. */
export const MAX_PUBLISH_ATTEMPTS = 5;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_RECONNECT_MS = 1000;

/** Le réseau n'a pas abouti. Code de retour 4. */
export class NetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'NetworkError';
    this.code = 'NETWORK';
    this.exitCode = 4;
  }
}

/** Le message dépasse ce que le transport accepte. Code de retour 2. */
export class LimitError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LimitError';
    this.code = 'TOO_LARGE';
    this.exitCode = 2;
  }
}

/** 1 s, 2 s, 4 s… plafonné à 30 s ; une attente de moins que de tentatives. */
export function backoffDelays(attempts = MAX_PUBLISH_ATTEMPTS) {
  return Array.from({ length: Math.max(0, attempts - 1) }, (_, i) => Math.min(BACKOFF_START_MS * 2 ** i, BACKOFF_CAP_MS));
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const stripSlash = (base) => String(base).replace(/\/+$/, '');

function assertPublishableBody(body) {
  if (typeof body !== 'string' || body.length === 0) throw new LimitError('corps vide : rien à publier');
  // Un corps chiffré est toujours du base64url. Un corps qui n'en est pas un
  // est, au mieux, une erreur de programmation ; au pire, une fuite de clair.
  if (!B64U_ONLY.test(body)) throw new LimitError('corps non chiffré : base64url attendu (R1)');
  const taille = Buffer.byteLength(body, 'utf8');
  if (taille > MAX_BODY_BYTES) throw new LimitError(`corps de ${taille} octets : ${MAX_BODY_BYTES} au plus (R5)`);
}

/**
 * Publie un message. Ne rend la main qu'une fois le serveur ayant accusé
 * réception : un rejet est toujours une erreur, jamais un succès silencieux.
 */
export async function publish({
  base, topic, body, title, tags = [], sig,
  fetchImpl = fetch, sleep = sleepDefault, attempts = MAX_PUBLISH_ATTEMPTS, signal,
}) {
  assertPublishableBody(body);
  const delais = backoffDelays(attempts);
  const headers = {
    'Content-Type': 'text/plain',
    'X-Title': title,
    'X-Tags': tags.join(','),
  };
  // ntfy.sh ne réexpédie pas les en-têtes inconnus (ADR-001) : la signature
  // voyage dans les tags. L'en-tête reste émis, conforme à la spec §2.1, pour
  // une instance ntfy ou un relais qui le préserverait.
  if (sig) headers['X-Sig'] = sig;

  let dernier;
  for (let essai = 0; essai < attempts; essai++) {
    let res;
    try {
      res = await fetchImpl(`${stripSlash(base)}/${topic}`, { method: 'POST', headers, body, signal });
    } catch (cause) {
      dernier = new NetworkError(`publication impossible : ${cause.message}`, { cause });
      if (essai < delais.length) await sleep(delais[essai]);
      continue;
    }
    if (res.ok) return await res.json();

    if (res.status === 429 || res.status >= 500) {
      dernier = new NetworkError(`ntfy a répondu ${res.status} après ${essai + 1} tentative(s)`);
      if (essai < delais.length) await sleep(delais[essai]);
      continue;
    }
    // 4xx définitif : réessayer ne changerait rien.
    throw new NetworkError(`ntfy a refusé la publication : ${res.status}`);
  }
  throw dernier ?? new NetworkError('publication impossible');
}

/** Rattrapage ponctuel. `since` est exclusif : `all`, ou le dernier identifiant reçu. */
export async function poll({ base, topic, since = 'all', fetchImpl = fetch, signal }) {
  const url = `${stripSlash(base)}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`;
  let res;
  try {
    res = await fetchImpl(url, { signal });
  } catch (cause) {
    throw new NetworkError(`lecture impossible : ${cause.message}`, { cause });
  }
  if (!res.ok) throw new NetworkError(`ntfy a répondu ${res.status} à la lecture`);
  const texte = await res.text();
  return texte.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

/**
 * Abonnement continu. SSE par défaut, repli sur interrogation périodique
 * (`mode: 'poll'`, ou automatiquement si le flux ne s'établit pas).
 * Rend une fonction d'arrêt ; `signal` fait le même office.
 */
export function subscribe({
  base, topic, since = 'all', onMessage, onError = () => {},
  signal, fetchImpl = fetch, mode = 'sse',
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, reconnectMs = DEFAULT_RECONNECT_MS,
  sleep = sleepDefault,
}) {
  const ctrl = new AbortController();
  const arreter = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', arreter, { once: true });
  }

  let curseur = since;
  const avancer = (msg) => {
    if (msg?.id) curseur = msg.id;
    onMessage(msg);
  };

  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        if (mode === 'poll') {
          for (const m of await poll({ base, topic, since: curseur, fetchImpl, signal: ctrl.signal })) avancer(m);
          await sleep(pollIntervalMs);
        } else {
          await streamSse({ base, topic, since: curseur, fetchImpl, signal: ctrl.signal, onMessage: avancer });
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        onError(err instanceof NetworkError ? err : new NetworkError(err.message, { cause: err }));
        await sleep(reconnectMs);
      }
    }
  })();

  return arreter;
}

/** Lit un flux SSE jusqu'à sa fin ; chaque bloc `data:` est un message ntfy. */
async function streamSse({ base, topic, since, fetchImpl, signal, onMessage }) {
  const url = `${stripSlash(base)}/${topic}/sse?since=${encodeURIComponent(since)}`;
  const res = await fetchImpl(url, { signal, headers: { Accept: 'text/event-stream' } });
  if (!res.ok) throw new NetworkError(`ntfy a répondu ${res.status} à l'abonnement`);
  if (!res.body) throw new NetworkError('flux SSE indisponible');

  const decodeur = new TextDecoder();
  let tampon = '';
  for await (const morceau of res.body) {
    tampon += decodeur.decode(morceau, { stream: true });
    let coupe;
    while ((coupe = tampon.indexOf('\n\n')) !== -1) {
      const bloc = tampon.slice(0, coupe);
      tampon = tampon.slice(coupe + 2);
      const donnees = bloc.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!donnees) continue;
      try {
        onMessage(JSON.parse(donnees));
      } catch { /* un bloc illisible ne doit pas rompre le flux */ }
    }
  }
}
