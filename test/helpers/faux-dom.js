/**
 * Un document minimal, construit à partir du vrai `web/index.html`.
 *
 * Le but n'est pas d'imiter un navigateur : c'est de tenir *exactement* la
 * surface que `app.js` utilise, à partir des identifiants réellement présents
 * dans la page. Un identifiant renommé dans le HTML sans l'être dans le code
 * fait donc échouer les tests, ce qu'un vrai navigateur n'aurait signalé qu'à
 * l'exécution, en production.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class FauxElement {
  constructor(tag, id = null, doc = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.doc = doc;
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.className = '';
    this.dataset = {};
    this.files = null;
    this.ecouteurs = new Map();
    this.clics = 0;
  }

  append(enfant) { this.children.push(enfant); return enfant; }
  replaceChildren(...enfants) { this.children = enfants; }
  addEventListener(type, fn) {
    if (!this.ecouteurs.has(type)) this.ecouteurs.set(type, []);
    this.ecouteurs.get(type).push(fn);
  }

  /** Déclenche un événement et rend la promesse des gestionnaires asynchrones. */
  async declencher(type, evenement = {}) {
    const ev = { preventDefault() {}, ...evenement };
    const gestionnaires = this.ecouteurs.get(type) ?? [];
    for (const fn of gestionnaires) await fn(ev);
    return gestionnaires.length;
  }

  click() { this.clics += 1; return this.declencher('click'); }

  /** Tout le texte rendu sous cet élément — ce qu'un humain lirait. */
  get texteRendu() {
    return [this.textContent, ...this.children.map((c) => c.texteRendu)].filter(Boolean).join(' ').trim();
  }
}

export class FauxDocument {
  constructor(declares) {
    this.elements = new Map();
    for (const d of declares) {
      const el = new FauxElement(d.tag ?? 'div', d.id, this);
      el.hidden = Boolean(d.hidden);
      this.elements.set(d.id, el);
    }
    this.crees = [];
  }

  getElementById(id) {
    const el = this.elements.get(id);
    if (!el) throw new Error(`identifiant absent de la page : ${id}`);
    return el;
  }

  createElement(tag) {
    const el = new FauxElement(tag, null, this);
    this.crees.push(el);
    return el;
  }
}

/**
 * Les éléments réellement déclarés dans web/index.html, avec leur état initial
 * `hidden`. Ce que la page cache au départ, le double le cache aussi : sans
 * cela, un test croirait visible ce que le navigateur n'affiche pas.
 * @returns {Array<{id:string, hidden:boolean, tag:string}>}
 */
export function elementsDeLaPage() {
  const html = readFileSync(join(RACINE, 'web', 'index.html'), 'utf8');
  return [...html.matchAll(/<([a-z][a-z0-9]*)\s([^>]*\bid="([^"]+)"[^>]*)>/gi)].map((m) => ({
    tag: m[1],
    id: m[3],
    hidden: /(^|\s)hidden(\s|=|$)/.test(m[2]),
  }));
}

export function documentDeLaPage() {
  return new FauxDocument(elementsDeLaPage());
}

/** Une adresse suffisante pour `app.js`. */
export function fausseAdresse(href) {
  const u = new URL(href);
  return {
    href,
    hash: u.hash,
    origin: u.origin,
    rechargements: 0,
    reload() { this.rechargements += 1; },
  };
}

export const fauxMinuteur = () => {
  const taches = [];
  return {
    taches,
    repeter: (fn) => taches.push(fn) - 1,
    arreter: (i) => { taches[i] = null; },
    battre: async () => { for (const t of taches) if (t) await t(); },
  };
};
