#!/usr/bin/env node
/**
 * Point d'entrée du CLI. Tout est dans lib/cli.js : ce fichier ne fait que
 * relier le processus au monde et propager le code de retour.
 */
import { run } from '../lib/cli.js';

const ctrl = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => ctrl.abort());
}

process.exitCode = await run(process.argv.slice(2), { signal: ctrl.signal });
