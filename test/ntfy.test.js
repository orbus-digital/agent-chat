import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import {
  publish, poll, subscribe, NetworkError, LimitError,
  MAX_BODY_BYTES, MAX_PUBLISH_ATTEMPTS, backoffDelays,
} from '../lib/ntfy.js';

const TOPIC = 'ac-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
let bus;

before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });

describe('ntfy — publication', () => {
  test('publie le corps tel quel, avec titre et tags', async () => {
    const m = await publish({ base: bus.base, topic: TOPIC, body: 'Q0lQSA', title: 'alice', tags: ['text', 'ts:1'] });
    assert.equal(m.message, 'Q0lQSA');
    assert.equal(m.title, 'alice');
    assert.deepEqual(m.tags, ['text', 'ts:1']);
    assert.ok(m.id);
  });

  test('refuse un corps de plus de 64 Ko (R5)', async () => {
    const trop = 'A'.repeat(MAX_BODY_BYTES + 1);
    await assert.rejects(() => publish({ base: bus.base, topic: TOPIC, body: trop, title: 'a', tags: [] }), LimitError);
    assert.equal(MAX_BODY_BYTES, 64 * 1024);
  });

  test('refuse de publier un corps qui ne serait pas du chiffré base64url (R1)', async () => {
    await assert.rejects(
      () => publish({ base: bus.base, topic: TOPIC, body: 'bonjour tout le monde', title: 'a', tags: [] }),
      /base64url/,
    );
  });

  test('refuse un corps vide', async () => {
    await assert.rejects(() => publish({ base: bus.base, topic: TOPIC, body: '', title: 'a', tags: [] }), /corps/);
  });
});

describe('ntfy — repli exponentiel sur 429 (AC-11, R5)', () => {
  beforeEach(() => bus.force429(0));

  test('les délais montent de 1 s à 30 s au plus', () => {
    assert.deepEqual(backoffDelays(5), [1000, 2000, 4000, 8000]);
    assert.deepEqual(backoffDelays(8), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test('un 429 passager est absorbé : le message part et rien n\'est perdu', async () => {
    bus.force429(2);
    const dormi = [];
    const m = await publish({
      base: bus.base, topic: TOPIC, body: 'UkVUUlk', title: 'alice', tags: ['text'],
      sleep: async (ms) => { dormi.push(ms); },
    });
    assert.equal(m.message, 'UkVUUlk');
    assert.deepEqual(dormi, [1000, 2000]);
    assert.equal(bus.remaining429, 0);
  });

  test('cinq échecs : erreur réseau de code 4, jamais « envoyé » (AC-11)', async () => {
    bus.force429(99);
    const dormi = [];
    const avant = bus.publishCount;
    await assert.rejects(
      () => publish({ base: bus.base, topic: TOPIC, body: 'RUNIRUM', title: 'alice', tags: ['text'], sleep: async (ms) => dormi.push(ms) }),
      (e) => {
        assert.ok(e instanceof NetworkError);
        assert.equal(e.exitCode, 4);
        assert.match(e.message, /429/);
        return true;
      },
    );
    assert.equal(dormi.length, MAX_PUBLISH_ATTEMPTS - 1, 'quatre attentes pour cinq tentatives');
    assert.equal(bus.publishCount, avant, 'aucun message stocké');
    bus.force429(0);
  });

  test('une panne réseau est aussi réessayée puis rendue en code 4', async () => {
    let appels = 0;
    await assert.rejects(
      () => publish({
        base: 'http://127.0.0.1:1', topic: TOPIC, body: 'UEFOTkU', title: 'a', tags: [],
        sleep: async () => {}, fetchImpl: async () => { appels += 1; throw new Error('ECONNREFUSED'); },
      }),
      NetworkError,
    );
    assert.equal(appels, MAX_PUBLISH_ATTEMPTS);
  });

  test("une erreur 4xx définitive n'est pas réessayée — inutile d'insister", async () => {
    let appels = 0;
    await assert.rejects(
      () => publish({
        base: bus.base, topic: TOPIC, body: 'QkFE', title: 'a', tags: [], sleep: async () => {},
        fetchImpl: async () => { appels += 1; return new Response('{"error":"bad"}', { status: 400 }); },
      }),
      NetworkError,
    );
    assert.equal(appels, 1);
  });
});

describe('ntfy — rattrapage par poll', () => {
  const T = 'ac-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  test('since=all rend tout, since=<id> rend la suite sans doublon (AC-07)', async () => {
    const a = await publish({ base: bus.base, topic: T, body: 'TTE', title: 'alice', tags: ['text'] });
    await publish({ base: bus.base, topic: T, body: 'TTI', title: 'bob', tags: ['text'] });

    const tout = await poll({ base: bus.base, topic: T, since: 'all' });
    assert.equal(tout.length, 2);

    const suite = await poll({ base: bus.base, topic: T, since: a.id });
    assert.equal(suite.length, 1);
    assert.equal(suite[0].message, 'TTI');
  });

  test('un topic vide rend un tableau vide, pas une erreur', async () => {
    assert.deepEqual(await poll({ base: bus.base, topic: 'ac-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', since: 'all' }), []);
  });

  test('une panne de lecture est rendue en code 4', async () => {
    await assert.rejects(() => poll({ base: 'http://127.0.0.1:1', topic: T, since: 'all' }), NetworkError);
  });
});

describe('ntfy — abonnement', () => {
  const T = 'ac-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

  test('le flux SSE délivre en direct et en moins de 3 s (AC-02)', async () => {
    const recus = [];
    const ctrl = new AbortController();
    const debut = Date.now();
    const attendu = new Promise((resolve) => {
      subscribe({
        base: bus.base, topic: T, since: 'all', signal: ctrl.signal,
        onMessage: (m) => { if (m.event === 'message') { recus.push(m); if (recus.length === 2) resolve(); } },
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    await publish({ base: bus.base, topic: T, body: 'TE1H', title: 'alice', tags: ['text'] });
    await publish({ base: bus.base, topic: T, body: 'TE1I', title: 'bob', tags: ['text'] });
    await attendu;
    ctrl.abort();
    assert.deepEqual(recus.map((m) => m.message), ['TE1H', 'TE1I']);
    assert.ok(Date.now() - debut < 3000, 'sous les 3 s exigées');
  });

  test('l\'événement « open » de ntfy est transmis tel quel — au protocole de l\'ignorer', async () => {
    const T2 = 'ac-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
    const ctrl = new AbortController();
    const vu = await new Promise((resolve) => {
      subscribe({ base: bus.base, topic: T2, since: 'all', signal: ctrl.signal, onMessage: resolve });
    });
    ctrl.abort();
    assert.equal(vu.event, 'open');
  });

  test('sans SSE, le repli interroge /json toutes les 5 s (non fonctionnel §7)', async () => {
    const T3 = 'ac-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    await publish({ base: bus.base, topic: T3, body: 'UE9MTA', title: 'alice', tags: ['text'] });
    const ctrl = new AbortController();
    const recus = [];
    const fini = new Promise((resolve) => {
      subscribe({
        base: bus.base, topic: T3, since: 'all', signal: ctrl.signal, mode: 'poll', pollIntervalMs: 10,
        onMessage: (m) => { recus.push(m); resolve(); },
      });
    });
    await fini;
    ctrl.abort();
    assert.equal(recus[0].message, 'UE9MTA');
  });

  test('le repli ne redonne jamais deux fois le même message (AC-07)', async () => {
    const T4 = 'ac-GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
    await publish({ base: bus.base, topic: T4, body: 'VU4', title: 'alice', tags: ['text'] });
    const ctrl = new AbortController();
    const recus = [];
    subscribe({ base: bus.base, topic: T4, since: 'all', signal: ctrl.signal, mode: 'poll', pollIntervalMs: 5, onMessage: (m) => recus.push(m) });
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    assert.equal(recus.length, 1, `reçu ${recus.length} fois`);
  });

  test('une coupure du flux est reprise là où elle s\'était arrêtée (AC-07)', async () => {
    const T5 = 'ac-HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH';
    const recus = [];
    const ctrl = new AbortController();
    subscribe({ base: bus.base, topic: T5, since: 'all', signal: ctrl.signal, reconnectMs: 10, onMessage: (m) => recus.push(m) });
    await new Promise((r) => setTimeout(r, 100));
    await publish({ base: bus.base, topic: T5, body: 'QVZBTlQ', title: 'alice', tags: ['text'] });
    await new Promise((r) => setTimeout(r, 100));
    bus.dropSubscribers();
    await new Promise((r) => setTimeout(r, 100));
    await publish({ base: bus.base, topic: T5, body: 'QVBSRVM', title: 'alice', tags: ['text'] });
    await new Promise((r) => setTimeout(r, 300));
    ctrl.abort();
    const corps = recus.filter((m) => m.event === 'message').map((m) => m.message);
    assert.deepEqual(corps, ['QVZBTlQ', 'QVBSRVM'], 'ni perte ni doublon après reprise');
  });
});
