/**
 * Serveur ntfy de test, en Node, sans dépendance (spec AC-12).
 *
 * Implémente la part du contrat ntfy que le client utilise réellement :
 *   POST /<topic>                       publication (X-Title, X-Tags)
 *   GET  /<topic>/json?poll=1&since=…   rattrapage, une ligne JSON par message
 *   GET  /<topic>/sse?since=…           flux SSE (« event: open » puis un data: par message)
 *
 * Et ce qu'il faut pour éprouver le client : 429 forcés, altération des
 * messages stockés, coupure du flux.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export class FakeNtfy {
  #server;
  #topics = new Map();      // topic -> messages[]
  #subs = new Set();        // { topic, res }
  #forced429 = 0;
  #publishCount = 0;

  constructor() {
    this.#server = createServer((req, res) => this.#route(req, res));
  }

  async start() {
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address();
    this.base = `http://127.0.0.1:${port}`;
    return this.base;
  }

  async stop() {
    for (const s of this.#subs) s.res.end();
    this.#subs.clear();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  /** Les N prochaines publications répondront 429. */
  force429(n) { this.#forced429 = n; }
  get publishCount() { return this.#publishCount; }
  get remaining429() { return this.#forced429; }

  messages(topic) { return this.#topics.get(topic) ?? []; }
  /** Réponse brute que verrait un curieux — support du test AC-03. */
  rawDump(topic) { return this.messages(topic).map((m) => JSON.stringify(m)).join('\n'); }

  /** Altère le dernier message stocké, comme le ferait un intermédiaire hostile. */
  tamper(topic, mutate) {
    const list = this.messages(topic);
    if (list.length === 0) throw new Error('rien à altérer');
    mutate(list[list.length - 1]);
  }

  /** Coupe tous les flux SSE ouverts, pour éprouver la reprise. */
  dropSubscribers() {
    for (const s of this.#subs) s.res.destroy();
    this.#subs.clear();
  }

  #route(req, res) {
    const url = new URL(req.url, this.base ?? 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 1) return this.#publish(req, res, parts[0]);
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') return this.#poll(req, res, parts[0], url);
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'sse') return this.#sse(req, res, parts[0], url);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 40401, error: 'topic not found' }));
  }

  #publish(req, res, topic) {
    if (this.#forced429 > 0) {
      this.#forced429 -= 1;
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 42901, error: 'limit reached' }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const msg = {
        id: randomBytes(6).toString('hex'),
        time: Math.floor(Date.now() / 1000),
        event: 'message',
        topic,
        title: req.headers['x-title'] ?? '',
        message: body,
        tags: String(req.headers['x-tags'] ?? '').split(',').filter(Boolean),
      };
      this.#publishCount += 1;
      if (!this.#topics.has(topic)) this.#topics.set(topic, []);
      this.#topics.get(topic).push(msg);
      for (const s of this.#subs) {
        if (s.topic === topic) s.res.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(msg));
    });
  }

  /** `since` est *exclusif*, comme sur ntfy.sh (vérifié empiriquement). */
  #after(topic, since) {
    const list = this.messages(topic);
    if (!since || since === 'all') return list;
    const i = list.findIndex((m) => m.id === since);
    return i === -1 ? list : list.slice(i + 1);
  }

  #poll(req, res, topic, url) {
    const out = this.#after(topic, url.searchParams.get('since'))
      .map((m) => JSON.stringify(m)).join('\n');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(out.length ? `${out}\n` : '');
  }

  #sse(req, res, topic, url) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: open\ndata: ${JSON.stringify({ id: randomBytes(6).toString('hex'), event: 'open', topic })}\n\n`);
    for (const m of this.#after(topic, url.searchParams.get('since'))) {
      res.write(`data: ${JSON.stringify(m)}\n\n`);
    }
    const sub = { topic, res };
    this.#subs.add(sub);
    req.on('close', () => this.#subs.delete(sub));
  }
}
