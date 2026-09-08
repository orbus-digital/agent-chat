#!/usr/bin/env node
/**
 * Recette visuelle de l'interface : `npm run recette`.
 *
 * `npm test` éprouve les règles ; il ne voit pas le rendu. Ce scénario ouvre
 * un vrai navigateur sur l'interface réellement servie, y crée une session
 * avec le CLI — le parcours d'AC-14, sans rien simuler —, et vérifie ce qu'un
 * humain verrait : la santé du bus, la taille des champs, le fait qu'un
 * message soit lisible sur un téléphone, le mode observateur, le thème sombre,
 * et **zéro erreur console** (AC-13).
 *
 * Playwright n'est pas une dépendance du dépôt et ne doit pas le devenir :
 * AC-14 promet « Node 22 et un navigateur seulement », et `npm test` reste
 * sans dépendance. Le module est donc résolu à l'exécution, et son absence est
 * dite avec la marche à suivre.
 *
 *   node scripts/recette-visuelle.mjs [--bus https://ntfy.sh] [--captures DIR]
 *                                     [--garder] [--port N]
 */

import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { run as agentchat } from '../lib/cli.js';

const RACINE = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

const { values } = parseArgs({
  options: {
    bus: { type: 'string', default: 'https://ntfy.sh' },
    // Hors de `coverage/`, que le portail de test efface à chaque `npm test` :
    // les captures doivent survivre à la commande suivante.
    captures: { type: 'string', default: join(RACINE, 'recette') },
    port: { type: 'string', default: '8123' },
    garder: { type: 'boolean', default: false },
  },
});

const PORT = Number(values.port);
const BASE = `http://127.0.0.1:${PORT}/`;
const CAPTURES = resolve(values.captures);

// ---------------------------------------------------------------- Playwright

/** @returns {Promise<object>} le module playwright, où qu'il soit installé. */
async function chargerPlaywright() {
  const require = createRequire(import.meta.url);
  const pistes = [RACINE, process.cwd(), join(RACINE, '..')];
  try {
    pistes.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* npm absent : les autres pistes suffiront peut-être */ }

  for (const piste of pistes) {
    try {
      const module = await import(pathToFileURL(require.resolve('playwright', { paths: [piste] })).href);
      // Playwright est publié en CommonJS : selon la piste, l'import rend le
      // module lui-même ou son `default`.
      const resolu = module.chromium ? module : module.default;
      if (resolu?.chromium) return resolu;
    } catch { /* piste suivante */ }
  }
  throw new Error(
    'Playwright est introuvable. La recette visuelle en a besoin, mais le dépôt\n'
    + "  n'en dépend pas — AC-14 promet « Node 22 et un navigateur seulement »,\n"
    + '  et `npm test` doit rester sans dépendance.\n\n'
    + '  Installez-le hors du dépôt, une fois :\n'
    + '      npm install -g playwright && npx playwright install chromium\n',
  );
}

// ------------------------------------------------------------------ verdict

const echecs = [];
const faits = [];
function verifier(condition, quoi, detail = '') {
  if (condition) { faits.push(`  ✓ ${quoi}`); return true; }
  echecs.push(`${quoi}${detail ? ` — ${detail}` : ''}`);
  faits.push(`  ✗ ${quoi}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const titre = (t) => faits.push(`\n${t}`);

// ------------------------------------------------------------------- décors

/** Sert `web/` comme `npm run web`, et rend de quoi l'arrêter. */
function servir() {
  const enfant = spawn(process.execPath, [join(RACINE, 'scripts', 'serve-web.mjs')], {
    cwd: RACINE, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  return () => enfant.kill();
}

async function attendreLeServeur(delai = 5000) {
  const fin = Date.now() + delai;
  for (;;) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch { /* pas encore prêt */ }
    if (Date.now() > fin) throw new Error(`serveur statique muet sur ${BASE}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Crée une session et y publie des messages, avec le CLI — comme un humain. */
async function preparerSession(nbMessages) {
  const home = mkdtempSync(join(tmpdir(), 'agentchat-recette-'));
  const lignes = [];
  // La recette est par définition un contexte de mise au point : un bus local
  // en clair y est acceptable (`--bus http://127.0.0.1:…`). La garde continue
  // de refuser toute adresse distante en clair, option ou pas (ADR-002).
  const io = { stdout: (l) => lignes.push(l), stderr: () => {}, home, uiBase: BASE, allowInsecure: true };

  if (await agentchat(['create', '--ttl', '2', '--as', 'agent-a', '--server', values.bus], io) !== 0) {
    throw new Error(`création impossible sur ${values.bus} — bus injoignable ?`);
  }
  const url = lignes.at(-1);
  for (let i = 1; i <= nbMessages; i += 1) {
    await agentchat(['send', url, `message ${i} de la recette`, '--as', 'agent-a'], io);
  }
  return { url, home };
}

// --------------------------------------------------------------------- page

/** Une page qui compte ses propres plaintes : toute erreur console est un échec. */
async function ouvrir(navigateur, options, tag) {
  const contexte = await navigateur.newContext(options);
  const page = await contexte.newPage();
  page.plaintes = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') page.plaintes.push(`${tag} ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => page.plaintes.push(`${tag} pageerror: ${e.message}`));
  return { contexte, page };
}

const mesure = (page, selecteur) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
  return { top, bottom, left, right, width, height };
}, selecteur);

// ------------------------------------------------------------------ scénario

const arreterServeur = servir();
let session = null;
let navigateur = null;
try {
  await attendreLeServeur();
  const { chromium } = await chargerPlaywright();
  navigateur = await chromium.launch();
  mkdirSync(CAPTURES, { recursive: true });
  session = await preparerSession(12);

  const plaintes = [];
  // Vue seule par défaut — c'est ce qu'un humain voit sans rien faire, et c'est
  // ce que la recette juge ; `entier` pour les écrans qu'on veut lire en entier.
  const capturer = (page, nom, entier = false) => page.screenshot({ path: join(CAPTURES, `${nom}.png`), fullPage: entier });

  // --- 1. accueil, téléphone de 390 px ------------------------------------
  titre('Accueil — 390 px');
  {
    const { contexte, page } = await ouvrir(navigateur, { viewport: { width: 390, height: 844 } }, '[accueil]');
    await page.goto(BASE, { waitUntil: 'networkidle' });

    verifier(!(await page.textContent('#sante-texte')).includes('vérification'),
      'la santé du bus est établie (AC-13)', await page.textContent('#sante-texte'));

    const debordement = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    verifier(debordement <= 0, 'rien ne déborde latéralement à 390 px', `${debordement} px de trop`);

    for (const champ of ['#creer-nom', '#creer-serveur']) {
      const b = await mesure(page, champ);
      verifier(b.height <= 64, `${champ} garde une hauteur de champ`, `${Math.round(b.height)} px`);
    }

    const [caseACocher, libelle] = await Promise.all([mesure(page, '#creer-prive'), mesure(page, '#creer-prive + span')]);
    verifier(caseACocher.bottom > libelle.top && caseACocher.top < libelle.bottom,
      'la case « métadonnées privées » est sur la ligne de son libellé',
      `case ${Math.round(caseACocher.top)}–${Math.round(caseACocher.bottom)}, libellé ${Math.round(libelle.top)}–${Math.round(libelle.bottom)}`);

    await capturer(page, '01-accueil-390');

    // création : les deux champs de lien restent des champs
    await page.fill('#creer-nom', 'agent-navigateur');
    await page.selectOption('#creer-ttl', '2');
    await page.click('#creer-bouton');
    await page.waitForSelector('#creer-resultat', { state: 'visible', timeout: 20_000 });
    for (const champ of ['#lien-participant', '#lien-observateur']) {
      const b = await mesure(page, champ);
      verifier(b.height <= 64, `${champ} garde une hauteur de champ`, `${Math.round(b.height)} px`);
    }
    verifier(await page.locator('#qr').isVisible(), 'le code QR du lien participant est affiché (§2.3)');

    // Le presse-papier pour de vrai : un bouton qui copie sans le dire ne se
    // distingue pas d'un bouton mort.
    await contexte.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await page.click('#copier-participant');
    // Le presse-papier est asynchrone : on attend que la page ait tranché,
    // plutôt que de lire un état intermédiaire.
    await page.waitForFunction(() => document.getElementById('copie-avis').textContent.length > 0, null, { timeout: 5000 });
    const avisCopie = await page.textContent('#copie-avis');
    verifier(/copié/i.test(avisCopie), 'la copie du lien participant est confirmée', avisCopie);
    const presse = await page.evaluate(() => navigator.clipboard.readText());
    verifier(presse === await page.inputValue('#lien-participant'),
      'c’est bien le lien participant qui est dans le presse-papier', presse.slice(0, 40));
    await capturer(page, '02-accueil-session-creee-390', true);
    plaintes.push(...page.plaintes);
    await contexte.close();
  }

  // --- 2. salon, téléphone de 390 px --------------------------------------
  titre('Salon — 390 px, douze messages');
  {
    const { contexte, page } = await ouvrir(navigateur, { viewport: { width: 390, height: 844 } }, '[salon]');
    await page.addInitScript(() => localStorage.setItem('agentchat:nom', 'agent-navigateur'));
    await page.goto(session.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#fil li').length >= 12, null, { timeout: 30_000 });

    verifier(await page.locator('#zone-ecriture').isVisible(), 'la zone d’écriture est offerte à un participant');

    const deborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    verifier(deborde <= 0, 'rien ne déborde latéralement dans le salon à 390 px', `${deborde} px de trop`);
    const bouton = await mesure(page, '#envoyer');
    verifier(bouton.right <= 390, 'le bouton « Envoyer » tient dans l’écran', `bord droit à ${Math.round(bouton.right)} px`);
    const composeur = await mesure(page, '#zone-ecriture');
    verifier(composeur.height <= 0.25 * 844, 'la zone d’écriture tient dans le quart bas de l’écran',
      `${Math.round(composeur.height)} px sur 844`);

    // La place réservée sous le fil (`--barre-ecriture`) doit rester plus haute
    // que la barre elle-même, sinon le message amené « en bas » atterrit
    // dessous. Les deux nombres sont liés : on les compare ici plutôt que de
    // laisser un futur ajout dans la barre les désaccorder en silence.
    const reserve = await page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--barre-ecriture').trim();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return v.endsWith('rem') ? parseFloat(v) * rem : parseFloat(v);
    });
    verifier(composeur.height <= reserve, 'la place réservée sous le fil couvre la zone d’écriture',
      `barre ${Math.round(composeur.height)} px, réserve ${Math.round(reserve)} px`);

    const saisie = await mesure(page, '#saisie');
    verifier(saisie.height <= 64, 'le champ de saisie garde une hauteur de champ', `${Math.round(saisie.height)} px`);

    const lisibles = await page.evaluate(() => {
      const zone = document.getElementById('zone-ecriture').getBoundingClientRect();
      return [...document.querySelectorAll('#fil li')]
        .map((li) => li.getBoundingClientRect())
        .filter((b) => b.top >= 0 && b.bottom <= zone.top).length;
    });
    verifier(lisibles >= 1, 'au moins un message est lisible sans rien déplacer (D-04)', `${lisibles} message(s)`);

    const dernier = await page.evaluate(() => {
      const lis = [...document.querySelectorAll('#fil li')];
      const b = lis.at(-1).getBoundingClientRect();
      const zone = document.getElementById('zone-ecriture').getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, hauteurVue: innerHeight, hautComposeur: zone.top, texte: lis.at(-1).innerText };
    });
    verifier(dernier.bottom <= dernier.hautComposeur + 1 && dernier.top >= 0,
      'le dernier message est visible, au-dessus de la zone d’écriture (D-05)',
      `message ${Math.round(dernier.top)}–${Math.round(dernier.bottom)}, composeur à ${Math.round(dernier.hautComposeur)}`);
    verifier(dernier.texte.includes('message 12'), 'le message affiché en dernier est bien le plus récent', dernier.texte.slice(0, 60));

    await capturer(page, '03-salon-390');
    plaintes.push(...page.plaintes);
    await contexte.close();
  }

  // --- 3. observateur, écran large, thème sombre --------------------------
  titre('Observateur — 1440 px, thème sombre');
  {
    const { contexte, page } = await ouvrir(navigateur, { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }, '[observateur]');
    await page.goto(`${session.url}&ro=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#fil li').length >= 12, null, { timeout: 30_000 });

    verifier(!(await page.locator('#zone-ecriture').isVisible()), 'aucune zone d’écriture en mode observateur (AC-06)');
    verifier(!(await page.locator('#identite').isVisible()), 'aucune demande de nom en mode observateur');
    verifier(/observateur/i.test(await page.textContent('#avis-salon')), 'le mode observateur est annoncé');

    const fond = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const clair = fond.match(/\d+/g).slice(0, 3).reduce((a, n) => a + Number(n), 0) / 3;
    verifier(clair < 80, 'le thème sombre est appliqué', fond);

    await capturer(page, '04-observateur-1440-sombre');
    plaintes.push(...page.plaintes);
    await contexte.close();
  }

  // --- 4. clé absente ------------------------------------------------------
  titre('Lien sans clé — 390 px');
  {
    const { contexte, page } = await ouvrir(navigateur, { viewport: { width: 390, height: 844 } }, '[sans-clé]');
    const topic = new URLSearchParams(session.url.split('#')[1]).get('t');
    await page.goto(`${BASE}#t=${topic}`, { waitUntil: 'domcontentloaded' });

    verifier(await page.locator('#vue-erreur').isVisible(), '« clé absente » est affiché (AC-06)');
    verifier(!(await page.locator('#vue-salon').isVisible()), 'le salon n’est pas monté sans clé');
    verifier((await page.locator('#fil li').count()) === 0, 'rien de lisible n’est rendu');

    await capturer(page, '05-cle-absente-390');
    plaintes.push(...page.plaintes);
    await contexte.close();
  }

  titre('Console');
  verifier(plaintes.length === 0, 'aucune erreur ni avertissement en console (AC-13)', plaintes.join(' | '));
} catch (err) {
  echecs.push(`recette interrompue : ${err.message}`);
} finally {
  await navigateur?.close();
  arreterServeur();
  if (session && !values.garder) rmSync(session.home, { recursive: true, force: true });
}

console.log(faits.join('\n'));
console.log(`\nCaptures : ${CAPTURES}`);
if (echecs.length > 0) {
  console.error(`\n✗ recette visuelle : ${echecs.length} écart(s)\n  - ${echecs.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✓ recette visuelle : l’interface se comporte comme la spec le décrit.');
