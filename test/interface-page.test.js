/**
 * La page elle-même : ce qu'un humain voit, et ce qu'il ne voit pas.
 *
 * Deux niveaux :
 *   — l'analyse statique de `web/index.html` et de la feuille de style, qui
 *     porte les exigences vérifiables sans exécution (CSP, aucun script
 *     externe, largeur mobile, thème sombre) — AC-13 ;
 *   — l'exécution de `app.js` sur un document minimal construit à partir des
 *     identifiants réels de la page — AC-06.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeNtfy } from './helpers/fake-ntfy.js';
import { documentDeLaPage, fausseAdresse, fauxMinuteur } from './helpers/faux-dom.js';
import { generateKey, generateTopic } from '../lib/crypto.js';
import { buildSessionUrl } from '../lib/url.js';
import { encodeB64u } from '../lib/bytes.js';
import { Salon } from '../web/js/salon.js';
import { demarrer, busAutorise, BUS_AUTORISES } from '../web/js/app.js';
import { versSvg } from '../web/js/qr.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(RACINE, 'web', 'index.html'), 'utf8');
const CSS = readFileSync(join(RACINE, 'web', 'css', 'style.css'), 'utf8');
const UI = 'https://exemple.test/chat/';

describe('page — politique de sécurité et ressources (AC-13)', () => {
  const csp = HTML.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';

  test('une politique de sécurité est déclarée dans la page', () => {
    assert.ok(csp.length > 0, 'aucune CSP dans index.html');
  });

  test('elle contient exactement les directives que la spec exige', () => {
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src[^;]*https:\/\/ntfy\.sh/);
  });

  test('elle ferme ce qui n\'a pas à être ouvert', () => {
    for (const directive of [/object-src 'none'/, /base-uri 'none'/, /frame-ancestors 'none'/]) {
      assert.match(csp, directive);
    }
    assert.equal(/unsafe-inline|unsafe-eval/.test(csp), false, 'la CSP se relâche');
  });

  test('aucune ressource externe : ni script, ni feuille de style, ni image d\'ailleurs', () => {
    const externes = [...HTML.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
    assert.deepEqual(externes, [], `ressources externes : ${externes.join(', ')}`);
  });

  test('aucun script en ligne ni gestionnaire « on… » — ce que la CSP interdirait de toute façon', () => {
    const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(scripts, [], `scripts en ligne : ${scripts.join(', ')}`);
    assert.equal(/\son[a-z]+="/.test(HTML), false, 'gestionnaire d\'événement en ligne');
    assert.equal(/\bstyle="/.test(HTML), false, 'style en ligne : la CSP style-src le refuserait');
  });

  test('le module de la page est bien un module, et local', () => {
    assert.match(HTML, /<script type="module" src="js\/app\.js"><\/script>/);
  });

  test('toute ressource référencée existe réellement sous web/', () => {
    const refs = [...HTML.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('/'));
    assert.ok(refs.length >= 2, 'la page ne référence ni script ni feuille de style');
    for (const r of refs) {
      if (r === './') continue;
      assert.ok(existsSync(join(RACINE, 'web', r)), `ressource introuvable : web/${r}`);
    }
  });

  test('la page se déclare en français et prévoit le mobile', () => {
    assert.match(HTML, /<html lang="fr">/);
    assert.match(HTML, /name="viewport" content="width=device-width/);
  });
});

describe('page — mise en forme (AC-13)', () => {
  test('la feuille de style prévoit le thème sombre', () => {
    assert.match(CSS, /prefers-color-scheme:\s*dark/);
  });

  test('elle prévoit explicitement l\'écran étroit de 390 px et l\'écran large', () => {
    assert.match(CSS, /@media[^{]*max-width:\s*(3[89]\d|4\d\d)px/);
    assert.match(CSS, /@media[^{]*min-width:\s*\d{3,4}px/);
  });

  test('aucune largeur fixe ne dépasse 390 px : la page ne déborde pas sur un téléphone', () => {
    const largeurs = [...CSS.matchAll(/(?:^|[\s;{])width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    const trop = largeurs.filter((px) => px > 390);
    assert.deepEqual(trop, [], `largeurs fixes trop grandes : ${trop.join(', ')}`);
  });

  test('l\'indicateur de santé a un aspect distinct selon l\'état du bus', () => {
    assert.match(CSS, /\[data-etat="vert"\]/);
    assert.match(CSS, /\[data-etat="rouge"\]/);
  });
});

describe('page — bus autorisés', () => {
  test('ntfy.sh est autorisé, un autre domaine ne l\'est pas', () => {
    assert.equal(busAutorise('https://ntfy.sh'), true);
    assert.equal(busAutorise('https://ntfy.sh/'), true);
    assert.equal(busAutorise('https://ailleurs.exemple'), false);
  });

  test('la liste des bus autorisés correspond à la CSP déclarée', () => {
    const csp = HTML.match(/content="([^"]*connect-src[^"]*)"/)?.[1] ?? '';
    for (const bus of BUS_AUTORISES) assert.ok(csp.includes(bus), `${bus} absent de la CSP`);
  });

  test('un bus de même origine que la page est joignable — recette locale', () => {
    assert.equal(busAutorise('http://127.0.0.1:8080', 'http://127.0.0.1:8080'), true);
  });
});

// ---------------------------------------------------------------------------

let bus;
before(async () => { bus = new FakeNtfy(); await bus.start(); });
after(async () => { await bus.stop(); });

let apps;
beforeEach(() => { apps = []; });
afterEach(() => { for (const a of apps) a.arreter(); });

/** Monte l'application sur un document minimal et rend { app, doc }. */
async function monter(hash, extra = {}) {
  const doc = documentDeLaPage();
  const minuteur = fauxMinuteur();
  const app = demarrer({
    document: doc,
    location: fausseAdresse(`${UI}${hash}`),
    minuteur,
    now: extra.now ?? (() => Date.now()),
    fabriqueSalon: (options) => new Salon({ ...options, server: bus.base }),
    ...extra,
  });
  apps.push(app);
  await app.pret;
  return { app, doc, minuteur };
}

const lienDe = (topic, key, suffixe = '') => {
  const u = buildSessionUrl({ topic, key, uiBase: UI });
  return u.slice(u.indexOf('#')) + suffixe;
};

const attendre = (predicat, delai = 5000) => new Promise((resolve, reject) => {
  const t = setInterval(() => {
    if (predicat()) { clearInterval(t); resolve(); }
    else if (delai-- <= 0) { clearInterval(t); reject(new Error('délai dépassé')); }
  }, 20);
});

describe('page — sans clé, rien de lisible (AC-06)', () => {
  test('un lien sans « k » affiche « clé absente » et ne monte pas le salon', async () => {
    const { app, doc } = await monter(`#t=${generateTopic()}`);
    assert.equal(app.vue, 'erreur');
    assert.match(doc.getElementById('erreur-titre').textContent, /Clé absente/i);
    assert.match(doc.getElementById('erreur-message').textContent, /clé absente/i);
    assert.equal(doc.getElementById('vue-salon').hidden, true);
    assert.equal(doc.getElementById('fil').children.length, 0, 'aucun message ne doit être rendu');
    assert.equal(doc.getElementById('zone-ecriture').hidden, true);
  });

  test('le topic lui-même n\'est pas affiché quand la clé manque', async () => {
    const topic = generateTopic();
    const { doc } = await monter(`#t=${topic}`);
    assert.equal(doc.getElementById('erreur-message').textContent.includes(topic), false);
    assert.equal(doc.getElementById('topic-court').textContent.includes(topic.slice(3, 10)), false);
  });

  test('une clé tronquée est traitée comme une clé absente, pas devinée', async () => {
    const { app } = await monter(`#t=${generateTopic()}&k=${encodeB64u(new Uint8Array(16))}`);
    assert.equal(app.vue, 'erreur');
    assert.equal(app.lecture.raison, 'cle-absente');
  });

  test('sans fragment du tout, c\'est l\'accueil qui s\'affiche', async () => {
    const { app, doc } = await monter('');
    assert.equal(app.vue, 'accueil');
    assert.equal(doc.getElementById('vue-accueil').hidden, false);
  });
});

describe('page — salon en direct (AC-06)', () => {
  test('un message publié apparaît déchiffré, avec auteur, heure et état vérifié', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const { app, doc } = await monter(lienDe(topic, key));

    assert.equal(app.vue, 'salon');
    // Un participant s'annonce, puis écrit.
    await doc.getElementById('nom-champ').declencher('input');
    doc.getElementById('nom-champ').value = 'alice';
    await doc.getElementById('identite').declencher('submit');
    doc.getElementById('saisie').value = 'bonjour';
    await doc.getElementById('zone-ecriture').declencher('submit');

    await attendre(() => doc.getElementById('fil').children.some((li) => li.texteRendu.includes('bonjour')));
    const ligne = doc.getElementById('fil').children.find((li) => li.texteRendu.includes('bonjour'));
    assert.match(ligne.texteRendu, /alice/);
    assert.match(ligne.texteRendu, /\d{2}:\d{2}/);
    assert.equal(ligne.className.includes('non-verifie'), false);
    assert.equal(doc.getElementById('saisie').value, '', 'la zone de saisie doit se vider');
  });

  test('le salon affiche le bus, le roster et l\'état de connexion', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const { doc } = await monter(lienDe(topic, key));
    assert.equal(doc.getElementById('serveur-courant').textContent, bus.base);
    assert.match(doc.getElementById('etat-connexion').textContent, /direct/);
    assert.match(doc.getElementById('topic-court').textContent, /^ac-/);
  });

  test('l\'indicateur de santé passe au vert quand le bus répond, au rouge sinon (AC-13)', async () => {
    const { app, doc } = await monter(lienDe(generateTopic(), generateKey()));
    assert.equal(doc.getElementById('sante').dataset.etat, 'vert');
    assert.match(doc.getElementById('sante-texte').textContent, /en service/);

    bus.healthy = false;
    try {
      await app.rafraichirSante();
      assert.equal(doc.getElementById('sante').dataset.etat, 'rouge');
      assert.match(doc.getElementById('sante-texte').textContent, /indisponible/);
    } finally {
      bus.healthy = true;
    }
  });

  test('un message est rendu comme du texte, jamais comme du balisage', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const { doc } = await monter(lienDe(topic, key));
    doc.getElementById('nom-champ').value = 'alice';
    await doc.getElementById('identite').declencher('submit');
    doc.getElementById('saisie').value = '<img src=x onerror=alert(1)>';
    await doc.getElementById('zone-ecriture').declencher('submit');

    await attendre(() => doc.getElementById('fil').children.some((li) => li.texteRendu.includes('<img')));
    const corps = doc.crees.find((e) => e.className === 'message-texte' && e.textContent.includes('<img'));
    assert.ok(corps, 'le texte doit être posé par textContent');
    assert.equal(corps.innerHTML, undefined, 'aucune écriture de balisage');
  });
});

describe('page — mode observateur (AC-06)', () => {
  test('avec « ro=1 », le fil s\'affiche mais aucune zone d\'écriture n\'est montée', async () => {
    const topic = generateTopic();
    const key = generateKey();

    // Un pair écrit d'abord, pour que l'observateur ait quelque chose à voir.
    const pair = new Salon({ topic, key, server: bus.base, participant: 'alice' });
    await pair.demarrer({ onMessage: () => {} });
    await pair.envoyer('vu par l\'observateur');
    pair.arreter();

    const { doc } = await monter(lienDe(topic, key, '&ro=1'));
    await attendre(() => doc.getElementById('fil').children.length > 0);

    assert.equal(doc.getElementById('zone-ecriture').hidden, true, 'zone d\'écriture visible pour un observateur');
    assert.equal(doc.getElementById('identite').hidden, true, 'même le nom ne doit pas être demandé');
    assert.match(doc.getElementById('avis-salon').textContent, /observateur/i);
    assert.match(doc.getElementById('fil').children[0].texteRendu, /vu par l'observateur/);
    assert.match(doc.getElementById('fil').children[0].texteRendu, /alice/);
  });
});

describe('page — au-delà du TTL (AC-10)', () => {
  test('le salon reste lisible, la zone d\'écriture disparaît', async () => {
    const topic = generateTopic();
    const key = generateKey();

    const createdAt = 1_780_000_000_000;
    const pair = new Salon({ topic, key, server: bus.base, participant: 'alice' });
    await pair.demarrer({ onMessage: () => {} });
    await pair.annoncer({ ttlH: 1, createdAt });
    await pair.envoyer('avant expiration');
    pair.arreter();

    const { doc } = await monter(lienDe(topic, key), { now: () => createdAt + 5 * 3600_000 });
    await attendre(() => doc.getElementById('fil').children.some((li) => li.texteRendu.includes('avant expiration')));

    assert.equal(doc.getElementById('zone-ecriture').hidden, true);
    assert.equal(doc.getElementById('identite').hidden, true);
    assert.match(doc.getElementById('avis-salon').textContent, /expirée/i);
    assert.equal(doc.getElementById('ttl-restant').textContent, 'expirée');
  });
});

describe('page — accueil et création (AC-01, §2.3)', () => {
  test('créer une session imprime un lien participant et un lien observateur', async () => {
    const { doc } = await monter('', { location: fausseAdresse(`${bus.base}/chat/`) });
    doc.getElementById('creer-nom').value = 'alice';
    doc.getElementById('creer-serveur').value = bus.base;
    await doc.getElementById('creer-form').declencher('submit');

    const lien = doc.getElementById('lien-participant').value;
    assert.match(lien, /#t=ac-[A-Za-z0-9_-]{32}&k=[A-Za-z0-9_-]{43}/);
    assert.equal(doc.getElementById('lien-observateur').value, `${lien}&ro=1`);
    assert.equal(doc.getElementById('creer-resultat').hidden, false);
  });

  test('la création publie un roster chiffré : le salon existe vraiment', async () => {
    const { doc } = await monter('', { location: fausseAdresse(`${bus.base}/chat/`) });
    doc.getElementById('creer-nom').value = 'alice';
    doc.getElementById('creer-serveur').value = bus.base;
    const avant = bus.publishCount;
    await doc.getElementById('creer-form').declencher('submit');

    assert.equal(bus.publishCount, avant + 1);
    const topic = new URLSearchParams(doc.getElementById('lien-participant').value.split('#')[1]).get('t');
    const roster = bus.messages(topic)[0];
    assert.ok(roster.tags.includes('control'));
    assert.match(roster.message, /^[A-Za-z0-9_-]+$/, 'le corps publié doit être du chiffré');
    assert.equal(roster.message.includes('alice'), false, 'le contenu du roster laisse fuir un nom');
    // Sans « métadonnées privées », le titre porte le nom du participant : c'est
    // assumé (D-01), et c'est précisément ce que l'option AC-15 vient corriger.
    assert.equal(roster.title, 'alice');
  });

  test('un bus non autorisé par la politique de sécurité est refusé, avec l\'explication', async () => {
    const { doc } = await monter('', { location: fausseAdresse(`${bus.base}/chat/`) });
    doc.getElementById('creer-nom').value = 'alice';
    doc.getElementById('creer-serveur').value = 'https://bus.ailleurs.exemple';
    const avant = bus.publishCount;
    await doc.getElementById('creer-form').declencher('submit');

    assert.equal(bus.publishCount, avant, 'une requête est partie vers un bus non autorisé');
    assert.match(doc.getElementById('aide-serveur').textContent, /politique de sécurité/i);
    assert.equal(doc.getElementById('creer-resultat').hidden, true);
  });

  test('un code QR du lien participant est affiché, et il encode bien ce lien', async () => {
    const { doc } = await monter('', { location: fausseAdresse(`${bus.base}/chat/`) });
    doc.getElementById('creer-nom').value = 'alice';
    doc.getElementById('creer-serveur').value = bus.base;
    await doc.getElementById('creer-form').declencher('submit');

    const image = doc.getElementById('qr');
    assert.equal(image.hidden, false);
    assert.match(image.src, /^data:image\/svg\+xml;charset=utf-8,/);
    assert.ok(image.width > 0 && image.width === image.height);

    // Le QR est régénéré ici depuis le lien affiché : s'il encodait autre
    // chose, l'image ne correspondrait pas.
    const attendu = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(versSvg(doc.getElementById('lien-participant').value))}`;
    assert.equal(image.src, attendu);
  });

  test('les liens se copient dans le presse-papier', async () => {
    const copies = [];
    const { doc } = await monter('', {
      presse: { ecrire: (t) => copies.push(t) },
      location: fausseAdresse(`${bus.base}/chat/`),
    });
    doc.getElementById('creer-nom').value = 'alice';
    doc.getElementById('creer-serveur').value = bus.base;
    await doc.getElementById('creer-form').declencher('submit');
    await doc.getElementById('copier-participant').declencher('click');
    await doc.getElementById('copier-observateur').declencher('click');

    assert.equal(copies.length, 2);
    assert.equal(copies[0], doc.getElementById('lien-participant').value);
    assert.match(copies[1], /&ro=1$/);
  });
});

describe('page — export et import (AC-09)', () => {
  test('exporter propose un fichier chiffré, importer le rend lisible', async () => {
    const topic = generateTopic();
    const key = generateKey();
    const fichiers = [];
    const { doc } = await monter(lienDe(topic, key), {
      telecharger: (nom, contenu) => fichiers.push({ nom, contenu }),
    });

    doc.getElementById('nom-champ').value = 'alice';
    await doc.getElementById('identite').declencher('submit');
    doc.getElementById('saisie').value = 'à archiver';
    await doc.getElementById('zone-ecriture').declencher('submit');
    await attendre(() => doc.getElementById('fil').children.some((li) => li.texteRendu.includes('à archiver')));

    await doc.getElementById('exporter').declencher('click');
    assert.equal(fichiers.length, 1);
    assert.equal(fichiers[0].nom, `${topic}.json`);
    assert.equal(fichiers[0].contenu.includes('à archiver'), false, 'l\'export laisse fuir le clair');

    // Le même fichier, relu par l'interface.
    const lecteur = await monter(lienDe(topic, key), { lireFichier: () => fichiers[0].contenu });
    await lecteur.doc.getElementById('fichier-import').declencher('change');
    assert.ok(
      lecteur.doc.getElementById('fil').children.some((li) => li.texteRendu.includes('à archiver')),
      'l\'import n\'a rien affiché',
    );
    assert.match(lecteur.doc.getElementById('avis-salon').textContent, /relus/);
  });

  test('un fichier qui n\'est pas un export est refusé avec un message', async () => {
    const { doc } = await monter(lienDe(generateTopic(), generateKey()), {
      lireFichier: () => '{"v":42}',
    });
    await doc.getElementById('fichier-import').declencher('change');
    assert.match(doc.getElementById('avis-salon').textContent, /illisible|version/i);
  });
});
