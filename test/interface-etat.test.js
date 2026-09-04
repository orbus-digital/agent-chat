/**
 * Couche d'état de l'interface : tout ce qui décide *quoi* montrer, isolé de
 * *comment* le montrer. C'est là que vivent les règles observables d'AC-06
 * (mode observateur, clé absente) et de R4 (TTL), donc c'est là qu'on les
 * éprouve — sans navigateur.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, generateTopic } from '../lib/crypto.js';
import { buildSessionUrl } from '../lib/url.js';
import { encodeB64u } from '../lib/bytes.js';
import {
  lireFragment, etatTtl, peutEcrire, vueMessage, Roster, HORAIRE,
} from '../web/js/etat.js';

const topic = generateTopic();
const key = generateKey();
const url = buildSessionUrl({ topic, key, uiBase: 'https://exemple.test/chat/' });
const fragment = url.slice(url.indexOf('#'));

describe('interface — lecture du fragment (AC-06)', () => {
  test('un fragment complet donne topic, clé et serveur', () => {
    const r = lireFragment(fragment);
    assert.equal(r.ok, true);
    assert.equal(r.topic, topic);
    assert.deepEqual(r.key, key);
    assert.equal(r.ro, false);
    assert.equal(r.server, 'https://ntfy.sh');
  });

  test('« ro=1 » est reconnu comme mode observateur', () => {
    assert.equal(lireFragment(`${fragment}&ro=1`).ro, true);
  });

  test('sans fragment du tout : accueil, pas erreur', () => {
    for (const vide of ['', '#', undefined, null]) {
      assert.deepEqual(lireFragment(vide), { ok: false, raison: 'accueil' });
    }
  });

  test('avec un topic mais sans clé : « clé absente », et rien de lisible', () => {
    const r = lireFragment(`#t=${topic}`);
    assert.equal(r.ok, false);
    assert.equal(r.raison, 'cle-absente');
    assert.match(r.message, /clé absente/i);
    assert.equal(r.key, undefined, 'aucune clé ne doit être devinée');
    assert.equal(r.topic, undefined, "rien du salon n'est exposé sans la clé");
  });

  test('une clé de mauvaise taille est refusée comme une clé absente', () => {
    const r = lireFragment(`#t=${topic}&k=${encodeB64u(new Uint8Array(16))}`);
    assert.equal(r.ok, false);
    assert.equal(r.raison, 'cle-absente');
  });

  test('un topic difforme est refusé sans être affiché', () => {
    const r = lireFragment(`#t=pas-un-topic&k=${encodeB64u(key)}`);
    assert.equal(r.ok, false);
    assert.equal(r.raison, 'lien-invalide');
  });

  test('un serveur ntfy porté par le fragment est restitué', () => {
    const autre = buildSessionUrl({ topic, key, server: 'https://ntfy.exemple.test', uiBase: 'https://x.test/' });
    assert.equal(lireFragment(autre.slice(autre.indexOf('#'))).server, 'https://ntfy.exemple.test');
  });
});

describe('interface — durée de vie (R4, AC-10)', () => {
  const createdAt = 1_780_000_000_000;

  test('avant l\'échéance, la session est vivante', () => {
    const e = etatTtl({ createdAt, ttlH: 2, maintenant: createdAt + 3600_000 });
    assert.equal(e.expire, false);
    assert.equal(e.expiresAt, createdAt + 2 * 3600_000);
    assert.ok(e.reste > 0);
  });

  test('à l\'échéance exactement, elle est expirée', () => {
    assert.equal(etatTtl({ createdAt, ttlH: 2, maintenant: createdAt + 2 * 3600_000 }).expire, true);
  });

  test('sans date de création connue, on considère la session expirée', () => {
    assert.equal(etatTtl({ createdAt: null, ttlH: 2, maintenant: createdAt }).expire, true);
  });

  test('le reste est présenté en heures et minutes', () => {
    const e = etatTtl({ createdAt, ttlH: 2, maintenant: createdAt + 3600_000 + 60_000 });
    assert.equal(e.resteLisible, '59 min');
    const large = etatTtl({ createdAt, ttlH: 24, maintenant: createdAt });
    assert.equal(large.resteLisible, '24 h');
  });
});

describe('interface — droit d\'écrire (AC-06, AC-10)', () => {
  test('un participant ordinaire, session vivante : il écrit', () => {
    assert.equal(peutEcrire({ ro: false, expire: false, cle: true }), true);
  });

  test('un observateur n\'écrit jamais — pas de zone de saisie', () => {
    assert.equal(peutEcrire({ ro: true, expire: false, cle: true }), false);
  });

  test('passé le TTL, plus personne n\'écrit', () => {
    assert.equal(peutEcrire({ ro: false, expire: true, cle: true }), false);
  });

  test('sans clé, il n\'y a rien à écrire ni à lire', () => {
    assert.equal(peutEcrire({ ro: false, expire: false, cle: false }), false);
  });
});

describe('interface — mise en forme d\'un message', () => {
  const base = { id: 'a1', ts: 1_780_000_000_000, from: 'alice', kind: 'text', text: 'bonjour', verified: true };

  test('un message ordinaire est présenté comme authentifié', () => {
    const v = vueMessage(base);
    assert.equal(v.auteur, 'alice');
    assert.equal(v.texte, 'bonjour');
    assert.equal(v.verifie, true);
    assert.equal(v.control, false);
    assert.match(v.heure, HORAIRE);
  });

  test('un message non vérifié le dit, et n\'est pas présenté comme authentique (AC-04)', () => {
    const v = vueMessage({ ...base, verified: false });
    assert.equal(v.verifie, false);
    assert.match(v.mention, /non vérifié/i);
  });

  test('un message d\'intégrité invalide ne rend aucun texte (AC-05)', () => {
    const v = vueMessage({ id: 'x', integrity: 'invalid' });
    assert.equal(v.texte, '');
    assert.equal(v.invalide, true);
    assert.match(v.mention, /intégrité invalide/i);
    assert.equal(v.auteur, '—', 'aucun auteur ne doit être supposé');
  });

  test('un message de contrôle est marqué comme tel, pour être affiché en gris (§4)', () => {
    const v = vueMessage({ ...base, kind: 'control', text: 'roster', meta: { type: 'roster' } });
    assert.equal(v.control, true);
    assert.match(v.texte, /roster/);
  });

  test('un ordre de migration est résumé lisiblement', () => {
    const v = vueMessage({ ...base, kind: 'control', text: 'migrate', meta: { type: 'migrate', topic: 'ac-nouveau' } });
    assert.match(v.texte, /migration/i);
  });
});

describe('interface — roster', () => {
  test('accumule les participants annoncés, sans doublon ni ordre surprenant', () => {
    const r = new Roster();
    r.appliquer({ kind: 'control', meta: { type: 'roster', participants: ['alice', 'bob'] } });
    r.appliquer({ kind: 'control', meta: { type: 'roster', participants: ['bob', 'carol'] } });
    assert.deepEqual(r.participants, ['alice', 'bob', 'carol']);
  });

  test('un message ordinaire fait connaître son auteur', () => {
    const r = new Roster();
    r.appliquer({ kind: 'text', from: 'dave', verified: true });
    assert.deepEqual(r.participants, ['dave']);
  });

  test('un message non vérifié n\'inscrit personne au roster', () => {
    const r = new Roster();
    r.appliquer({ kind: 'text', from: 'mallory', verified: false });
    assert.deepEqual(r.participants, []);
  });

  test('le roster retient la durée de vie annoncée', () => {
    const r = new Roster();
    r.appliquer({ kind: 'control', verified: true, meta: { type: 'roster', participants: [], ttlH: 3, createdAt: 42 } });
    assert.deepEqual({ ttlH: r.ttlH, createdAt: r.createdAt }, { ttlH: 3, createdAt: 42 });
  });
});
