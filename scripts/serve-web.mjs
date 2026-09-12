#!/usr/bin/env node
/**
 * Petit serveur statique pour la recette locale : `npm run web`.
 *
 * Il existe pour une raison précise : l'interface est faite de modules ES, et
 * un navigateur refuse de charger un module depuis `file://`. Ouvrir
 * `web/index.html` à la main ne marcherait donc pas, et faire dépendre la
 * recette d'un paquet téléchargé contredirait la promesse « Node 22 et un
 * navigateur, rien d'autre » (AC-14).
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'web'));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const serveur = createServer(async (req, res) => {
  try {
    const chemin = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const cible = resolve(join(RACINE, normalize(chemin)));
    // Une seule barrière, mais claire : rien ne sort de web/. Le lien
    // symbolique web/lib n'y contrevient pas, le chemin demandé restant
    // « /lib/… » sous la racine.
    if (cible !== RACINE && !cible.startsWith(`${RACINE}/`)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('interdit');
      return;
    }
    const fichier = (await stat(cible)).isDirectory() ? join(cible, 'index.html') : cible;
    const corps = await readFile(fichier);
    res.writeHead(200, {
      'content-type': TYPES[extname(fichier)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(corps);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('introuvable');
  }
});

serveur.listen(PORT, '127.0.0.1', () => {
  console.log(`Interface servie sur http://127.0.0.1:${PORT}/`);
  console.log('Ctrl-C pour arrêter.');
});
