/**
 * Le noyau est chargé tel quel par le navigateur depuis GitHub Pages. Rien
 * n'avertit quand une régression y réintroduit `Buffer` ou un `node:*` : le
 * CLI continue de passer, et c'est l'interface qui tombe, en production, sur
 * un écran blanc. Ce test est le garde-fou de cet invariant.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Les modules que le navigateur charge. `session.js` et `cli.js` sont, eux, légitimement propres à Node. */
export const MODULES_ISOMORPHES = ['bytes.js', 'crypto.js', 'sign.js', 'serveur.js', 'url.js', 'protocol.js', 'ntfy.js', 'archive.js'];
const MODULES_NODE = ['session.js', 'cli.js'];

const lire = (f) => readFileSync(join(RACINE, 'lib', f), 'utf8');

describe('noyau isomorphe', () => {
  test('la liste couvre exactement le contenu de lib/', () => {
    const presents = readdirSync(join(RACINE, 'lib')).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(presents, [...MODULES_ISOMORPHES, ...MODULES_NODE].sort());
  });

  for (const f of MODULES_ISOMORPHES) {
    test(`${f} n'importe aucun module « node: »`, () => {
      const source = lire(f);
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const fautifs = imports.filter((i) => i.startsWith('node:'));
      assert.deepEqual(fautifs, [], `${f} importe ${fautifs.join(', ')}`);
    });

    test(`${f} n'utilise pas Buffer`, () => {
      // `ArrayBuffer` et `ArrayBuffer.isView` sont universels : seule
      // l'identité `Buffer` propre à Node est proscrite.
      const source = lire(f).replaceAll('ArrayBuffer', '').replaceAll('arrayBuffer', '');
      assert.equal(/\bBuffer\b/.test(source.replace(/^\s*\*.*$/gm, '')), false, `${f} mentionne Buffer`);
    });

    test(`${f} se charge sans aucun accès au système de fichiers`, async () => {
      const mod = await import(`../lib/${f}`);
      assert.ok(Object.keys(mod).length > 0, `${f} n'exporte rien`);
    });
  }

  test('les modules Node ne sont importés par aucun module isomorphe', () => {
    for (const f of MODULES_ISOMORPHES) {
      for (const nodeOnly of MODULES_NODE) {
        assert.equal(lire(f).includes(`./${nodeOnly}`), false, `${f} importe ${nodeOnly}`);
      }
    }
  });
});

describe('publication de l\'interface', () => {
  test('web/lib pointe sur le noyau du dépôt — sinon Pages servirait du vide', () => {
    const lien = join(RACINE, 'web', 'lib');
    assert.ok(existsSync(lien), 'web/lib est absent : l\'interface ne trouverait pas le noyau');
    assert.equal(realpathSync(lien), realpathSync(join(RACINE, 'lib')));
  });

  test('chaque module isomorphe est atteignable depuis web/lib', () => {
    for (const f of MODULES_ISOMORPHES) {
      assert.ok(existsSync(join(RACINE, 'web', 'lib', f)), `web/lib/${f} introuvable`);
    }
  });

  test('le workflow Pages matérialise le lien : un artefact ne transporte pas les liens symboliques', () => {
    const wf = readFileSync(join(RACINE, '.github', 'workflows', 'pages.yml'), 'utf8');
    assert.match(wf, /rm web\/lib/, 'le lien n\'est pas retiré avant la copie');
    assert.match(wf, /cp -r lib web\/lib/, 'le noyau n\'est pas copié dans l\'artefact');
    assert.match(wf, /path: web/, 'ce n\'est pas web\/ qui est publié');
  });

  test('l\'interface ne référence le noyau que par des chemins relatifs à web/', () => {
    const modules = readdirSync(join(RACINE, 'web', 'js')).filter((f) => f.endsWith('.js'));
    for (const f of modules) {
      const source = readFileSync(join(RACINE, 'web', 'js', f), 'utf8');
      const sortants = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
        .map((m) => m[1])
        .filter((i) => i.startsWith('..') && !i.startsWith('../lib/'));
      assert.deepEqual(sortants, [], `${f} sort de web/ : ${sortants.join(', ')}`);
    }
  });
});
