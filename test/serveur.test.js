/**
 * La politique d'adressage du bus, éprouvée aux quatre endroits où une URL de
 * serveur ntfy entre dans le programme : l'option `--server`, le paramètre `s`
 * du lien de session, l'environnement, et l'appel réseau lui-même.
 *
 * Ce que ces tests protègent n'est pas la confidentialité des messages — le
 * chiffré reste du chiffré sur http:// — mais celle des **métadonnées** : sur
 * un bus en clair, `X-Title` (l'auteur), `X-Tags` (le kind) et le nom du topic
 * voyagent lisibles, et `--private-meta` ne protège alors plus de rien vis-à-vis
 * d'un observateur du réseau.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import {
  normaliseServeur, assertBaseTransport, estBoucleLocale, origineDeDeveloppement,
  UsageError, DEFAULT_NTFY_BASE,
} from '../lib/serveur.js';
import { buildSessionUrl, parseSessionUrl } from '../lib/url.js';
import { publish, poll, subscribe } from '../lib/ntfy.js';
import { generateKey, generateTopic } from '../lib/crypto.js';
import { encodeB64u } from '../lib/bytes.js';
import { run, EXIT } from '../lib/cli.js';
import { lireFragment } from '../web/js/etat.js';
import { sonderSante } from '../web/js/salon.js';

const topic = generateTopic();
const key = generateKey();
const LOCAL = 'http://127.0.0.1:8123';
const DISTANT = 'http://bus.exemple.test';

describe('serveur — la garde de schéma, une seule pour tout le programme', () => {
  test('accepte https, avec ou sans barre finale, avec ou sans chemin', () => {
    assert.equal(normaliseServeur('https://bus.exemple.test'), 'https://bus.exemple.test');
    assert.equal(normaliseServeur('https://bus.exemple.test/'), 'https://bus.exemple.test');
    assert.equal(normaliseServeur('https://bus.exemple.test/ntfy//'), 'https://bus.exemple.test/ntfy');
  });

  test('refuse http:// hors boucle locale, et dit pourquoi', () => {
    assert.throws(() => normaliseServeur(DISTANT), (err) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /http:\/\/ refusé/);
      assert.match(err.message, /X-Title|clair/);
      assert.match(err.message, /https:\/\/bus\.exemple\.test/, 'le message doit montrer l\'URL à écrire');
      return true;
    });
  });

  test('--allow-insecure ne rattrape pas un serveur distant : la faille resterait entière', () => {
    assert.throws(
      () => normaliseServeur(DISTANT, { allowInsecure: true }),
      /boucle locale/,
    );
  });

  test('refuse http:// sur la boucle locale tant que personne ne l\'a demandé', () => {
    assert.throws(() => normaliseServeur(LOCAL), (err) => {
      assert.match(err.message, /http:\/\/ refusé/);
      assert.match(err.message, /--allow-insecure/, 'le message doit nommer l\'option qui débloque');
      return true;
    });
  });

  test('accepte http:// sur la boucle locale quand on l\'a demandé, sous ses trois écritures', () => {
    for (const base of ['http://localhost:8123', 'http://127.0.0.1:8123', 'http://[::1]:8123']) {
      assert.equal(normaliseServeur(base, { allowInsecure: true }), base);
    }
  });

  test('toute la plage de bouclage 127.0.0.0/8 compte comme locale', () => {
    assert.equal(estBoucleLocale('127.0.0.1'), true);
    assert.equal(estBoucleLocale('127.5.4.3'), true);
    assert.equal(estBoucleLocale('LOCALHOST'), true);
    assert.equal(estBoucleLocale('[::1]'), true);
    assert.equal(estBoucleLocale('bus.exemple.test'), false);
    assert.equal(estBoucleLocale('127.0.0.1.exemple.test'), false, 'un nom qui commence par 127. n\'est pas la boucle locale');
  });

  test('refuse un schéma qui n\'est ni http ni https', () => {
    for (const base of ['ftp://bus.exemple.test', 'file:///tmp/bus', 'ws://bus.exemple.test']) {
      assert.throws(() => normaliseServeur(base, { allowInsecure: true }), /refusé/);
    }
  });

  test('refuse une adresse sans schéma plutôt que d\'en deviner un', () => {
    assert.throws(() => normaliseServeur('bus.exemple.test'), UsageError);
    assert.throws(() => normaliseServeur('//bus.exemple.test'), UsageError);
  });

  test('refuse le vide et ce qui n\'est pas une chaîne', () => {
    for (const rien of ['', '   ', null, undefined, 42, {}]) {
      assert.throws(() => normaliseServeur(rien), UsageError);
    }
  });

  test('le refus porte le code de retour 2 du CLI, pas le code réseau', () => {
    try { normaliseServeur(DISTANT); } catch (err) { assert.equal(err.exitCode, 2); }
  });

  test('le bus par défaut passe la garde sans rien demander', () => {
    assert.equal(normaliseServeur(DEFAULT_NTFY_BASE), DEFAULT_NTFY_BASE);
  });
});

describe('serveur — deux niveaux : l\'invariant du transport, la politique du CLI', () => {
  test('le transport laisse passer la boucle locale sans consentement — un serveur de test n\'est pas une fuite', () => {
    assert.equal(assertBaseTransport(LOCAL), LOCAL);
  });

  test('le transport refuse le clair vers le réseau, quoi qu\'en dise son appelant', () => {
    assert.throws(() => assertBaseTransport(DISTANT), UsageError);
  });

  test('une origine de développement est une origine en clair sur la boucle locale', () => {
    assert.equal(origineDeDeveloppement('http://127.0.0.1:8123'), true);
    assert.equal(origineDeDeveloppement('http://localhost:8123'), true);
    assert.equal(origineDeDeveloppement('https://exemple.test'), false);
    assert.equal(origineDeDeveloppement('http://exemple.test'), false);
    assert.equal(origineDeDeveloppement('n\'importe quoi'), false);
  });
});

describe('serveur — le lien de session', () => {
  test('on ne fabrique pas un lien qui dégradera celui qui l\'ouvrira', () => {
    assert.throws(() => buildSessionUrl({ topic, key, server: DISTANT }), /http:\/\/ refusé/);
    assert.throws(() => buildSessionUrl({ topic, key, server: LOCAL }), /--allow-insecure/);
  });

  test('un lien vers un bus local reste fabricable pour la mise au point', () => {
    const url = buildSessionUrl({ topic, key, server: LOCAL, allowInsecure: true });
    assert.equal(parseSessionUrl(url, { allowInsecure: true }).server, LOCAL);
  });

  test('un lien reçu ne peut pas nous faire retomber en clair — le vecteur principal', () => {
    // Le lien vient d'un tiers : c'est le seul de ces chemins qu'un attaquant
    // contrôle de bout en bout. Un `s=` en clair doit être refusé à la lecture,
    // même si la construction, elle, a eu lieu ailleurs.
    const forge = `https://chat.exemple.test/#t=${topic}&k=${encodeB64u(key)}&s=${encodeB64u(new TextEncoder().encode(DISTANT))}`;
    assert.throws(() => parseSessionUrl(forge), (err) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /lien/, 'le message doit dire que le bus vient du lien');
      assert.match(err.message, /http:\/\/ refusé/);
      return true;
    });
    assert.throws(() => parseSessionUrl(forge, { allowInsecure: true }), /boucle locale/);
  });

  test('un lien sans paramètre s garde le bus par défaut, qui est en https', () => {
    assert.equal(parseSessionUrl(buildSessionUrl({ topic, key })).server, DEFAULT_NTFY_BASE);
  });
});

describe('serveur — le transport ne parle pas en clair au réseau', () => {
  const jamais = () => { throw new Error('une requête est partie vers un bus en clair'); };
  const corps = 'UEFOTkU';

  test('publish refuse avant d\'ouvrir la moindre connexion', async () => {
    await assert.rejects(
      () => publish({ base: DISTANT, topic, body: corps, title: 'a', tags: [], fetchImpl: jamais }),
      UsageError,
    );
  });

  test('poll refuse avant d\'ouvrir la moindre connexion', async () => {
    await assert.rejects(() => poll({ base: DISTANT, topic, fetchImpl: jamais }), UsageError);
  });

  test('subscribe refuse tout de suite, sans boucle de reconnexion silencieuse', () => {
    assert.throws(
      () => subscribe({ base: DISTANT, topic, onMessage: () => {}, fetchImpl: jamais }),
      UsageError,
    );
  });
});

// --------------------------------------------------------------------- CLI

let bus;
let home;
before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agentchat-s-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** `run()` sans consentement implicite : c'est justement ce qu'on éprouve ici. */
async function lancer(argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    home,
    now: () => 1_780_000_000_000,
    sleep: async () => {},
    uiBase: 'https://chat.exemple.test/',
    allowInsecure: false,
    ntfyBase: DEFAULT_NTFY_BASE,
    ...extra,
  });
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('serveur — le CLI', () => {
  test('create --server http:// distant : code 2, message clair, rien de publié', async () => {
    const avant = bus.publishCount;
    const r = await lancer(['create', '--server', DISTANT]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /http:\/\/ refusé/);
    assert.equal(r.out.length, 0, 'aucune URL de session ne doit être imprimée');
    assert.equal(bus.publishCount, avant, 'aucun roster ne doit partir');
  });

  test('create --server http:// local : refusé tant que --allow-insecure n\'est pas là', async () => {
    const r = await lancer(['create', '--server', bus.base]);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /--allow-insecure/);
  });

  test('create --server http:// local avec --allow-insecure : accepté', async () => {
    const r = await lancer(['create', '--server', bus.base, '--allow-insecure']);
    assert.equal(r.code, EXIT.OK);
    assert.match(r.out[0], /^https:\/\/chat\.exemple\.test\/#t=/);
    assert.equal(parseSessionUrl(r.out[0], { allowInsecure: true }).server, bus.base);
  });

  test('--allow-insecure ne débloque pas un bus distant', async () => {
    const r = await lancer(['create', '--server', DISTANT, '--allow-insecure']);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /boucle locale/);
  });

  test('un lien dont le bus est en clair est refusé à l\'usage, pas seulement à la création', async () => {
    const forge = `https://chat.exemple.test/#t=${topic}&k=${encodeB64u(key)}&s=${encodeB64u(new TextEncoder().encode(DISTANT))}`;
    for (const argv of [['tail', forge, '--once'], ['send', forge, 'x', '--as', 'A'], ['export', forge], ['join', forge, '--as', 'A']]) {
      const r = await lancer(argv, { fetchImpl: () => { throw new Error('requête partie vers un bus en clair'); } });
      assert.equal(r.code, EXIT.USAGE, `${argv[0]} aurait dû refuser`);
      assert.match(r.stderr, /http:\/\/ refusé/);
    }
  });

  test('AGENTCHAT_ALLOW_INSECURE=1 vaut consentement, pour ne pas répéter l\'option à chaque commande', async () => {
    const avant = process.env.AGENTCHAT_ALLOW_INSECURE;
    process.env.AGENTCHAT_ALLOW_INSECURE = '1';
    try {
      const out = [];
      const code = await run(['create', '--server', bus.base], {
        stdout: (l) => out.push(l), stderr: () => {}, home, now: () => 1_780_000_000_000, sleep: async () => {},
        uiBase: 'https://chat.exemple.test/',
      });
      assert.equal(code, EXIT.OK);
      assert.equal(out.length, 1);
    } finally {
      if (avant === undefined) delete process.env.AGENTCHAT_ALLOW_INSECURE;
      else process.env.AGENTCHAT_ALLOW_INSECURE = avant;
    }
  });

  test('NTFY_BASE_URL fixe le bus par défaut, et --server l\'emporte sur elle (spec §10)', async () => {
    const r = await lancer(['create', '--allow-insecure'], { ntfyBase: bus.base });
    assert.equal(r.code, EXIT.OK);
    assert.equal(parseSessionUrl(r.out[0], { allowInsecure: true }).server, bus.base);

    const q = await lancer(['create', '--server', DISTANT, '--allow-insecure'], { ntfyBase: bus.base });
    assert.equal(q.code, EXIT.USAGE, '--server doit primer, donc être vérifié');
  });

  test('un NTFY_BASE_URL en clair est refusé comme le serait --server', async () => {
    const r = await lancer(['create'], { ntfyBase: DISTANT });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /http:\/\/ refusé/);
  });

  test('l\'aide nomme --allow-insecure : une option qu\'on ne peut pas deviner n\'existe pas', async () => {
    const r = await lancer(['help']);
    assert.match(r.stdout, /--allow-insecure/);
  });
});

// ---------------------------------------------------------------- interface

describe('serveur — l\'interface est tenue à la même règle', () => {
  const fragmentVers = (base) => `#t=${topic}&k=${encodeB64u(key)}&s=${encodeB64u(new TextEncoder().encode(base))}`;

  test('un lien vers un bus en clair n\'ouvre pas le salon : il est invalide, pas à moitié utilisable', () => {
    const r = lireFragment(fragmentVers(DISTANT));
    assert.equal(r.ok, false);
    assert.equal(r.raison, 'lien-invalide');
    assert.match(r.message, /http:\/\/ refusé/);
  });

  test('une page servie en clair localement peut ouvrir un lien vers son bus local', () => {
    const r = lireFragment(fragmentVers(LOCAL), { allowInsecure: true });
    assert.equal(r.ok, true);
    assert.equal(r.server, LOCAL);
  });

  test('le consentement de la page ne s\'étend pas à un bus distant', () => {
    assert.equal(lireFragment(fragmentVers(DISTANT), { allowInsecure: true }).ok, false);
  });

  test('la sonde de santé ne part pas non plus vers un bus en clair', async () => {
    let appels = 0;
    const r = await sonderSante({ base: DISTANT, fetchImpl: () => { appels += 1; } });
    assert.equal(appels, 0, 'une requête est partie vers un bus en clair');
    assert.equal(r.healthy, false);
    assert.match(r.raison, /http:\/\/ refusé/);
  });

  test('la sonde reste une valeur, jamais une exception — un bus refusé est un état à afficher', async () => {
    await assert.doesNotReject(() => sonderSante({ base: 'pas une url', fetchImpl: () => {} }));
  });
});
