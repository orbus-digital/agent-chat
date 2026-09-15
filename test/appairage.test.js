/**
 * Le protocole d'appairage (ADR-003) : entrer dans un salon sans que la clé de
 * session voyage dans une URL.
 *
 * Trois tests portent tout l'édifice, et ce sont les seuls dont l'échec
 * signifierait que le mécanisme ne sert à rien :
 *   — la **substitution de clé publique** est refusée (le code EST l'empreinte) ;
 *   — un **code expiré** est refusé (5 minutes) ;
 *   — un **code déjà consommé** est refusé (usage unique).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET_CODE, CODE_LEN, VALIDITE_MS, SUJET_RE, VERSION,
  AppairageError, empreinteDe, codeDe, codeDepuisEmpreinte, formaterCode,
  normaliserCode, sujetDe, ouvrirDemande, lireOffres, lireOctrois,
  choisirOffre, preparerOctroi, lireOctroiPour,
} from '../lib/appairage.js';
import { TOPIC_RE, generateKey, generateTopic, IntegrityError } from '../lib/crypto.js';
import { encodeB64u, decodeB64u, utf8, fromUtf8 } from '../lib/bytes.js';

/** Un message ntfy tel que le bus le rendrait, autour d'un corps déjà encodé. */
const brut = ({ body, tags, id = Math.random().toString(36).slice(2) }) => ({
  id, event: 'message', topic: 'acp-x', title: 'ac', message: body, tags,
});

/** Le salon que le membre offre au demandeur. */
const invitationType = () => ({
  topic: generateTopic(),
  k: encodeB64u(generateKey()),
  server: 'https://ntfy.exemple.test',
  ttlH: 2,
  createdAt: 1_788_000_000_000,
  participants: ['membre'],
});

/** Publie l'offre du demandeur, puis l'octroi d'un membre : le fil du sujet. */
async function filComplet({ maintenant = 1_788_000_000_000, invitation = invitationType() } = {}) {
  const demande = await ouvrirDemande({ ts: maintenant });
  const offre = brut({ body: demande.offre.body, tags: demande.offre.tags });
  const { octroi } = await preparerOctroi({
    code: demande.code, messages: [offre], invitation, maintenant: maintenant + 1000,
  });
  return { demande, invitation, offre, octroiBrut: brut({ body: octroi.body, tags: octroi.tags }) };
}

describe('appairage — le code', () => {
  test("l'alphabet est du base32 sans les caractères ambigus (I, L, O, U)", () => {
    assert.equal(ALPHABET_CODE.length, 32);
    assert.equal(new Set(ALPHABET_CODE).size, 32);
    for (const ambigu of ['I', 'L', 'O', 'U']) {
      assert.equal(ALPHABET_CODE.includes(ambigu), false, `${ambigu} reste ambigu à l'oreille ou à l'œil`);
    }
  });

  test('le code fait 10 caractères, soit ~50 bits (ADR-003)', async () => {
    for (let i = 0; i < 20; i++) {
      const d = await ouvrirDemande();
      assert.equal(d.code.length, CODE_LEN);
      assert.equal(CODE_LEN * 5, 50);
      for (const c of d.code) assert.ok(ALPHABET_CODE.includes(c), `caractère hors alphabet : ${c}`);
    }
  });

  test('le code EST l\'empreinte de la clé publique : même clé, même code', async () => {
    const d = await ouvrirDemande();
    assert.equal(await codeDe(d.pubRaw), d.code);
    assert.equal(codeDepuisEmpreinte(await empreinteDe(d.pubRaw)), d.code);
  });

  test('deux clés donnent deux codes, et deux empreintes', async () => {
    const a = await ouvrirDemande();
    const b = await ouvrirDemande();
    assert.notEqual(a.code, b.code);
    assert.notDeepEqual(a.empreinte, b.empreinte);
  });

  test("l'empreinte est séparée de tout autre usage : 32 octets, et pas le simple SHA-256 de la clé", async () => {
    const d = await ouvrirDemande();
    const emp = await empreinteDe(d.pubRaw);
    assert.equal(emp.length, 32);
    const nu = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', d.pubRaw));
    assert.notDeepEqual(emp, nu, 'sans séparation de domaine, la même empreinte servirait deux protocoles');
  });

  test('se dicte en trois groupes — KXR7-2M4Q-9T', async () => {
    const d = await ouvrirDemande();
    assert.equal(d.codeLisible, `${d.code.slice(0, 4)}-${d.code.slice(4, 8)}-${d.code.slice(8)}`);
    assert.match(formaterCode('KXR72M4Q9T'), /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
  });
});

describe('appairage — la saisie du code', () => {
  test('tolère ce qu\'un humain tape : minuscules, tirets, espaces', () => {
    for (const saisi of ['KXR72M4Q9T', 'kxr7-2m4q-9t', ' KXR7 2M4Q 9T ', 'kxr72m4q9t']) {
      assert.equal(normaliserCode(saisi), 'KXR72M4Q9T');
    }
  });

  test('corrige les confusions que l\'alphabet a écartées : I et L valent 1, O vaut 0', () => {
    assert.equal(normaliserCode('I23456789A'), '123456789A');
    assert.equal(normaliserCode('l23456789a'), '123456789A');
    assert.equal(normaliserCode('O23456789A'), '023456789A');
  });

  test('refuse une longueur fausse, un caractère hors alphabet, ou rien du tout', () => {
    for (const mauvais of ['', 'ABC', 'KXR72M4Q9T0', 'KXR72M4Q9U', 'KXR72M4Q9!', null, 42]) {
      assert.throws(() => normaliserCode(mauvais), (e) => e instanceof AppairageError && e.raison === 'code-invalide');
    }
  });

  test('un code refusé sort en code 2 — c\'est un usage, pas une attaque', () => {
    assert.throws(() => normaliserCode('ABC'), (e) => e.exitCode === 2);
  });
});

describe('appairage — le sujet de rendez-vous', () => {
  test('se dérive du code seul : un membre qui n\'a que le code le trouve', async () => {
    const d = await ouvrirDemande();
    assert.equal(await sujetDe(d.code), d.sujet);
    assert.equal(await sujetDe(formaterCode(d.code).toLowerCase()), d.sujet, 'la saisie humaine mène au même sujet');
  });

  test('a la forme attendue et change avec le code', async () => {
    const a = await sujetDe('KXR72M4Q9T');
    const b = await sujetDe('KXR72M4Q9V');
    assert.match(a, SUJET_RE);
    assert.notEqual(a, b);
  });

  test('ne peut jamais être pris pour un topic de session', async () => {
    assert.equal(TOPIC_RE.test(await sujetDe('KXR72M4Q9T')), false);
  });

  test('ne laisse pas retrouver le code : le sujet est un haché, pas un encodage', async () => {
    const sujet = await sujetDe('KXR72M4Q9T');
    assert.equal(sujet.includes('KXR7'), false);
    assert.equal(sujet.toUpperCase().includes('2M4Q'), false);
  });
});

describe('appairage — l\'offre du demandeur', () => {
  test('ne publie que du matériel public, et rien qui identifie', async () => {
    const d = await ouvrirDemande({ ts: 1_788_000_000_000 });
    assert.equal(d.offre.title, 'ac');
    const charge = JSON.parse(fromUtf8(decodeB64u(d.offre.body)));
    assert.deepEqual(Object.keys(charge).sort(), ['exp', 'pk', 't', 'ts', 'v']);
    assert.equal(charge.t, 'offer');
    assert.equal(decodeB64u(charge.pk).length, 65, 'un point P-256 non compressé');
    assert.equal(charge.exp, 1_788_000_000_000 + VALIDITE_MS);
  });

  test('le corps publié est du base64url — le transport n\'accepte rien d\'autre (R1)', async () => {
    const d = await ouvrirDemande();
    assert.match(d.offre.body, /^[A-Za-z0-9_-]+$/);
  });

  test('la validité est de 5 minutes', () => {
    assert.equal(VALIDITE_MS, 5 * 60_000);
  });

  test('deux demandes ne partagent ni clé, ni code, ni sujet', async () => {
    const a = await ouvrirDemande();
    const b = await ouvrirDemande();
    assert.notEqual(a.offre.body, b.offre.body);
    assert.notEqual(a.sujet, b.sujet);
  });
});

describe('appairage — l\'aller-retour complet', () => {
  test('le demandeur retrouve exactement l\'invitation que le membre a scellée', async () => {
    const { demande, invitation, octroiBrut } = await filComplet();
    const ouverte = await lireOctroiPour({ demande, raw: octroiBrut });
    assert.deepEqual(ouverte, { v: VERSION, ...invitation });
  });

  test('la clé de session n\'apparaît nulle part dans ce qui est publié', async () => {
    const { demande, invitation, offre, octroiBrut } = await filComplet();
    const publie = `${offre.message}|${octroiBrut.message}|${JSON.stringify(offre.tags)}|${JSON.stringify(octroiBrut.tags)}`;
    assert.equal(publie.includes(invitation.k), false, 'la clé de session est lisible sur le bus');
    assert.equal(publie.includes(invitation.topic), false, 'le topic du salon est lisible sur le bus');
    assert.ok(demande.code.length === CODE_LEN);
  });

  test('un octroi adressé à une autre empreinte n\'est pas pour nous', async () => {
    const autre = await ouvrirDemande();
    const { demande, octroiBrut } = await filComplet();
    assert.equal(await lireOctroiPour({ demande: autre, raw: octroiBrut }), null);
    assert.ok(await lireOctroiPour({ demande, raw: octroiBrut }));
  });

  test('un message de service du bus n\'est pas un octroi', async () => {
    const { demande } = await filComplet();
    assert.equal(await lireOctroiPour({ demande, raw: { event: 'open', id: 'x' } }), null);
    assert.equal(await lireOctroiPour({ demande, raw: brut({ body: encodeB64u(utf8('pas du json')), tags: ['pair-grant'] }) }), null);
  });
});

describe('appairage — LE test : la substitution de clé publique est refusée', () => {
  test('une clé publique substituée ne correspond plus au code, et le membre refuse', async () => {
    const legitime = await ouvrirDemande();
    const adversaire = await ouvrirDemande();

    // L'adversaire publie SA clé publique sur le sujet dérivé du code de la victime.
    const substitue = brut({ body: adversaire.offre.body, tags: adversaire.offre.tags });

    await assert.rejects(
      () => preparerOctroi({ code: legitime.code, messages: [substitue], invitation: invitationType() }),
      (e) => e instanceof AppairageError && e.raison === 'aucune-offre',
    );
  });

  test('quand les deux clés sont là, le membre scelle pour la bonne — et elle seule ouvre', async () => {
    const legitime = await ouvrirDemande();
    const adversaire = await ouvrirDemande();
    const invitation = invitationType();

    const messages = [
      brut({ body: adversaire.offre.body, tags: adversaire.offre.tags }),
      brut({ body: legitime.offre.body, tags: legitime.offre.tags }),
    ];
    const { octroi } = await preparerOctroi({ code: legitime.code, messages, invitation });
    const raw = brut({ body: octroi.body, tags: octroi.tags });

    assert.deepEqual(await lireOctroiPour({ demande: legitime, raw }), { v: VERSION, ...invitation });
    assert.equal(await lireOctroiPour({ demande: adversaire, raw }), null);
  });

  test("une offre dont la clé n'est pas un point de la courbe est écartée, pas fatale", async () => {
    const legitime = await ouvrirDemande();
    const faux = encodeB64u(utf8(JSON.stringify({
      v: VERSION, t: 'offer', pk: encodeB64u(new Uint8Array(65).fill(4)), ts: Date.now(), exp: Date.now() + VALIDITE_MS,
    })));
    const messages = [
      brut({ body: faux, tags: ['pair-offer'] }),
      brut({ body: legitime.offre.body, tags: legitime.offre.tags }),
    ];
    const { octroi } = await preparerOctroi({ code: legitime.code, messages, invitation: invitationType() });
    assert.ok(await lireOctroiPour({ demande: legitime, raw: brut({ body: octroi.body, tags: octroi.tags }) }));
  });

  test('un octroi dont le chiffré est altéré ne rend rien de partiel', async () => {
    const { demande, octroiBrut } = await filComplet();
    const charge = JSON.parse(fromUtf8(decodeB64u(octroiBrut.message)));
    const octets = decodeB64u(charge.ct);
    octets[octets.length - 1] ^= 0x01;
    charge.ct = encodeB64u(octets);
    const altere = brut({ body: encodeB64u(utf8(JSON.stringify(charge))), tags: octroiBrut.tags });

    await assert.rejects(() => lireOctroiPour({ demande, raw: altere }), (e) => e instanceof IntegrityError);
  });

  test("un octroi scellé pour une AUTRE clé de membre ne s'ouvre pas sous la nôtre", async () => {
    const { demande, octroiBrut } = await filComplet();
    const autreMembre = await ouvrirDemande();
    const charge = JSON.parse(fromUtf8(decodeB64u(octroiBrut.message)));
    charge.pk = encodeB64u(autreMembre.pubRaw); // la clé du membre est dans l'AAD et dans la dérivation
    const falsifie = brut({ body: encodeB64u(utf8(JSON.stringify(charge))), tags: octroiBrut.tags });

    await assert.rejects(() => lireOctroiPour({ demande, raw: falsifie }), (e) => e instanceof IntegrityError);
  });
});

describe('appairage — LE test : un code expiré est refusé', () => {
  test('cinq minutes après, le membre refuse', async () => {
    const t0 = 1_788_000_000_000;
    const d = await ouvrirDemande({ ts: t0 });
    const messages = [brut({ body: d.offre.body, tags: d.offre.tags })];

    // À la dernière seconde, ça passe encore.
    await assert.doesNotReject(() => preparerOctroi({
      code: d.code, messages, invitation: invitationType(), maintenant: t0 + VALIDITE_MS - 1,
    }));

    await assert.rejects(
      () => preparerOctroi({ code: d.code, messages, invitation: invitationType(), maintenant: t0 + VALIDITE_MS }),
      (e) => e instanceof AppairageError && e.raison === 'code-expire' && e.exitCode === 3,
    );
  });

  test("une offre qui s'accorde une validité plus longue n'en obtient pas plus", async () => {
    const t0 = 1_788_000_000_000;
    const d = await ouvrirDemande({ ts: t0 });
    const charge = JSON.parse(fromUtf8(decodeB64u(d.offre.body)));
    charge.exp = t0 + 30 * 24 * 3600_000; // un mois
    const gourmande = brut({ body: encodeB64u(utf8(JSON.stringify(charge))), tags: d.offre.tags });

    await assert.rejects(
      () => preparerOctroi({ code: d.code, messages: [gourmande], invitation: invitationType(), maintenant: t0 + VALIDITE_MS }),
      (e) => e.raison === 'code-expire',
    );
  });

  test('le demandeur connaît lui aussi sa date de péremption', async () => {
    const t0 = 1_788_000_000_000;
    const d = await ouvrirDemande({ ts: t0 });
    assert.equal(d.expiresAt, t0 + VALIDITE_MS);
  });
});

describe('appairage — LE test : un code déjà consommé est refusé', () => {
  test('un octroi déjà publié pour cette empreinte ferme le code', async () => {
    const t0 = 1_788_000_000_000;
    const { demande, offre, octroiBrut } = await filComplet({ maintenant: t0 });

    await assert.rejects(
      () => preparerOctroi({
        code: demande.code, messages: [offre, octroiBrut], invitation: invitationType(), maintenant: t0 + 2000,
      }),
      (e) => e instanceof AppairageError && e.raison === 'deja-consomme' && e.exitCode === 3,
    );
  });

  test("un octroi destiné à une AUTRE empreinte ne consomme pas ce code", async () => {
    const t0 = 1_788_000_000_000;
    const d = await ouvrirDemande({ ts: t0 });
    const autre = await filComplet({ maintenant: t0 });
    const messages = [brut({ body: d.offre.body, tags: d.offre.tags }), autre.octroiBrut];

    await assert.doesNotReject(() => preparerOctroi({
      code: d.code, messages, invitation: invitationType(), maintenant: t0 + 2000,
    }));
  });

  test('le refus est le même quel que soit le membre : il se mesure sur le bus, pas en local', async () => {
    const t0 = 1_788_000_000_000;
    const { demande, offre, octroiBrut } = await filComplet({ maintenant: t0 });
    // Un second membre, sans aucun état partagé avec le premier, voit le même fil.
    await assert.rejects(
      () => preparerOctroi({
        code: demande.code, messages: [octroiBrut, offre], invitation: invitationType(), maintenant: t0 + 3000,
      }),
      (e) => e.raison === 'deja-consomme',
    );
  });
});

describe('appairage — lecture d\'un fil bruyant', () => {
  test('rien à lire : le membre le dit, il n\'invente pas', async () => {
    await assert.rejects(
      () => preparerOctroi({ code: 'KXR72M4Q9T', messages: [], invitation: invitationType() }),
      (e) => e instanceof AppairageError && e.raison === 'aucune-offre' && e.exitCode === 5,
    );
  });

  test('les corps illisibles, les autres types et les événements de service sont ignorés', async () => {
    const messages = [
      { event: 'open', id: 'a' },
      { event: 'keepalive', id: 'b' },
      brut({ body: 'pas du base64url !!', tags: ['pair-offer'] }),
      brut({ body: encodeB64u(utf8('{ pas du json')), tags: ['pair-offer'] }),
      brut({ body: encodeB64u(utf8(JSON.stringify({ v: 1, t: 'autre' }))), tags: ['pair-offer'] }),
      brut({ body: encodeB64u(utf8(JSON.stringify({ v: 99, t: 'offer', pk: 'AAAA', ts: 1, exp: 2 }))), tags: ['pair-offer'] }),
    ];
    assert.deepEqual(lireOffres(messages), []);
    assert.deepEqual(lireOctrois(messages), []);
  });

  test('entre deux offres qui portent le même code, la première publiée l\'emporte', async () => {
    const t0 = 1_788_000_000_000;
    const d = await ouvrirDemande({ ts: t0 });
    const premiere = brut({ body: d.offre.body, tags: d.offre.tags, id: '1' });
    const seconde = brut({ body: d.offre.body, tags: d.offre.tags, id: '2' });
    const choisie = await choisirOffre({ code: d.code, messages: [premiere, seconde], maintenant: t0 + 1000 });
    assert.equal(choisie.id, '1', 'un arrivant tardif ne doit pas pouvoir déplacer une offre acceptée');
  });

  test('une offre sans horodatage crédible est écartée', async () => {
    const t0 = 1_788_000_000_000;
    for (const ts of [0, -1, 'hier', Number.NaN, undefined]) {
      const charge = { v: VERSION, t: 'offer', pk: encodeB64u(new Uint8Array(65)), ts, exp: t0 };
      assert.deepEqual(lireOffres([brut({ body: encodeB64u(utf8(JSON.stringify(charge))), tags: ['pair-offer'] })]), []);
    }
  });
});

describe('appairage — l\'octroi publié', () => {
  test('est du base64url, sans titre ni tag qui identifie qui que ce soit', async () => {
    const { octroiBrut } = await filComplet();
    assert.match(octroiBrut.message, /^[A-Za-z0-9_-]+$/);
    assert.ok(octroiBrut.tags.includes('pair-grant'));
    const charge = JSON.parse(fromUtf8(decodeB64u(octroiBrut.message)));
    assert.deepEqual(Object.keys(charge).sort(), ['ct', 'pk', 't', 'to', 'ts', 'v']);
  });

  test('nomme l\'empreinte visée, pas le code — le code ne se retrouve pas sur le bus', async () => {
    const { demande, octroiBrut } = await filComplet();
    const charge = JSON.parse(fromUtf8(decodeB64u(octroiBrut.message)));
    assert.equal(charge.to, encodeB64u(demande.empreinte));
    assert.equal(octroiBrut.message.includes(demande.code), false);
  });

  test('une invitation vide ou sans clé est refusée avant publication', async () => {
    const d = await ouvrirDemande();
    const messages = [brut({ body: d.offre.body, tags: d.offre.tags })];
    for (const invitation of [null, {}, { topic: 'ac-x' }, { topic: generateTopic(), k: 'trop-court' }]) {
      await assert.rejects(
        () => preparerOctroi({ code: d.code, messages, invitation }),
        (e) => e instanceof AppairageError && e.raison === 'invitation-invalide',
      );
    }
  });
});
