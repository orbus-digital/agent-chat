#!/usr/bin/env node
/**
 * Portail de test du dépôt : `npm test`.
 *
 * Un seul passage de `node --test` produit à la fois le compte rendu lisible
 * et la couverture au format lcov ; le portail refuse ensuite la suite si un
 * module du noyau descend sous le seuil que la spec fixe (AC-12 : 80 % sur
 * `lib/crypto`, `lib/sign`, `lib/ntfy`).
 *
 * Un seuil global aurait laissé un module critique se dégrader derrière la
 * moyenne des autres : le portail est donc par fichier.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const LCOV = join(RACINE, 'coverage', 'lcov.info');

/**
 * AC-12 — le noyau cryptographique et le transport ne descendent pas sous 80 %.
 * `lib/serveur.js` y est ajouté : c'est une garde de sécurité, et une garde non
 * couverte est une garde dont on ne sait pas si elle mord encore (ADR-002).
 * Les modules de l'interface sont tenus au même seuil : ce sont eux qui portent
 * les règles observables du salon (mode observateur, TTL, clé absente).
 */
const SEUILS = {
  'lib/crypto.js': 80,
  'lib/sign.js': 80,
  'lib/serveur.js': 80,
  'lib/ntfy.js': 80,
  'web/js/etat.js': 80,
  'web/js/salon.js': 80,
  'web/js/app.js': 80,
  'web/js/qr.js': 80,
};

rmSync(join(RACINE, 'coverage'), { recursive: true, force: true });
mkdirSync(join(RACINE, 'coverage'), { recursive: true });

const res = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=lib/**',
  '--test-coverage-include=web/js/**',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${LCOV}`,
  'test/*.test.js',
], { cwd: RACINE, stdio: 'inherit' });

if (res.status !== 0) {
  console.error('\n✗ des tests ont échoué — la couverture n\'est pas évaluée.');
  process.exit(res.status ?? 1);
}

/** @returns {Map<string, {hit:number, found:number}>} lignes couvertes par fichier */
function lireLcov(chemin) {
  const par = new Map();
  let courant = null;
  for (const ligne of readFileSync(chemin, 'utf8').split('\n')) {
    if (ligne.startsWith('SF:')) {
      courant = relative(RACINE, ligne.slice(3).trim()).split('\\').join('/');
      par.set(courant, { hit: 0, found: 0 });
    } else if (courant && ligne.startsWith('LH:')) {
      par.get(courant).hit = Number(ligne.slice(3));
    } else if (courant && ligne.startsWith('LF:')) {
      par.get(courant).found = Number(ligne.slice(3));
    }
  }
  return par;
}

const couverture = lireLcov(LCOV);
const manquants = [];

console.log('\nCouverture des modules sous seuil (AC-12)\n');
for (const [fichier, seuil] of Object.entries(SEUILS)) {
  const c = couverture.get(fichier);
  if (!c || c.found === 0) {
    manquants.push(`${fichier} — absent du rapport de couverture`);
    console.log(`  ✗ ${fichier.padEnd(16)} absent du rapport`);
    continue;
  }
  const pct = (100 * c.hit) / c.found;
  const ok = pct >= seuil;
  if (!ok) manquants.push(`${fichier} — ${pct.toFixed(1)} % < ${seuil} %`);
  console.log(`  ${ok ? '✓' : '✗'} ${fichier.padEnd(16)} ${pct.toFixed(1).padStart(5)} %  (seuil ${seuil} %)`);
}

if (manquants.length > 0) {
  console.error(`\n✗ couverture insuffisante :\n  - ${manquants.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n✓ tests verts et couverture du noyau au-dessus du seuil.');
