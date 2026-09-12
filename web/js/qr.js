/**
 * Encodeur QR minimal, en mode octet, niveau de correction L, versions 1 à 10.
 *
 * Pourquoi maison : la page ne charge aucune ressource externe (sa politique
 * de sécurité l'interdit), et le dépôt n'a aucune dépendance. Pourquoi si
 * réduit : une URL de session tient largement dans une version 10-L (274
 * octets), et chaque version supplémentaire serait de la table sans usage.
 *
 * Référence : ISO/IEC 18004. Les tables ci-dessous en sont l'extrait strictement
 * nécessaire ; tout le reste est calculé.
 */

/** Nombre total de mots de code (données + correction) par version. */
const MOTS_TOTAUX = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
/** Mots de correction par bloc, niveau L. */
const CORRECTION_PAR_BLOC = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
/** Nombre de blocs, niveau L. */
const BLOCS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
/** Centres des motifs d'alignement, par version (vide en version 1). */
const ALIGNEMENTS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const NIVEAU_L = 0b01;
const MODE_OCTET = 0b0100;

// -------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // polynôme primitif du standard
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Polynôme générateur de degré `n`. */
function generateur(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const suivant = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      suivant[j] ^= mul(g[j], 1);
      suivant[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = suivant;
  }
  return g;
}

/** Mots de correction d'un bloc de données. */
export function correction(donnees, nbCorrection) {
  const g = generateur(nbCorrection);
  const reste = new Array(nbCorrection).fill(0);
  for (const octet of donnees) {
    const facteur = octet ^ reste[0];
    reste.shift();
    reste.push(0);
    if (facteur !== 0) for (let i = 0; i < nbCorrection; i++) reste[i] ^= mul(g[i + 1], facteur);
  }
  return reste;
}

// ---------------------------------------------------------------- BCH

/** Information de format : 5 bits utiles, BCH(15,5), masque final du standard. */
export function bitsFormat(niveau, masque) {
  const donnees = (niveau << 3) | masque;
  let reste = donnees << 10;
  for (let i = 14; i >= 10; i--) if (reste & (1 << i)) reste ^= 0b10100110111 << (i - 10);
  return ((donnees << 10) | reste) ^ 0b101010000010010;
}

/**
 * Information de version, requise à partir de la version 7 : BCH(18,6).
 * Générateur x¹² + x¹¹ + x¹⁰ + x⁹ + x⁸ + x⁵ + x² + 1.
 */
export function bitsVersion(version) {
  let reste = version << 12;
  for (let i = 17; i >= 12; i--) if (reste & (1 << i)) reste ^= 0b1111100100101 << (i - 12);
  return (version << 12) | reste;
}

// ------------------------------------------------------- flux de données

/** Capacité utile, en octets, d'une version au niveau L. */
export function capaciteOctets(version) {
  const i = version - 1;
  const motsDonnees = MOTS_TOTAUX[i] - CORRECTION_PAR_BLOC[i] * BLOCS[i];
  const enTete = 4 + (version < 10 ? 8 : 16);
  return motsDonnees - Math.ceil(enTete / 8);
}

/** La plus petite version qui accueille `n` octets, ou null. */
export function versionPour(n) {
  for (let v = 1; v <= 10; v++) if (capaciteOctets(v) >= n) return v;
  return null;
}

function motsDeDonnees(octets, version) {
  const i = version - 1;
  const total = MOTS_TOTAUX[i] - CORRECTION_PAR_BLOC[i] * BLOCS[i];
  const bits = [];
  const pousser = (valeur, n) => { for (let k = n - 1; k >= 0; k--) bits.push((valeur >> k) & 1); };

  pousser(MODE_OCTET, 4);
  pousser(octets.length, version < 10 ? 8 : 16);
  for (const o of octets) pousser(o, 8);

  // Terminateur, puis alignement sur l'octet.
  for (let k = 0; k < 4 && bits.length < total * 8; k++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const mots = [];
  for (let k = 0; k < bits.length; k += 8) {
    mots.push(bits.slice(k, k + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  // Remplissage réglementaire, alternant.
  for (let k = 0; mots.length < total; k++) mots.push(k % 2 === 0 ? 0xec : 0x11);
  return mots;
}

/** Découpe en blocs, calcule la correction, puis entrelace comme l'exige le standard. */
function motsFinaux(octets, version) {
  const i = version - 1;
  const nbBlocs = BLOCS[i];
  const nbCorrection = CORRECTION_PAR_BLOC[i];
  const donnees = motsDeDonnees(octets, version);

  const court = Math.floor(donnees.length / nbBlocs);
  const nbLongs = donnees.length % nbBlocs;

  const blocs = [];
  let curseur = 0;
  for (let b = 0; b < nbBlocs; b++) {
    const taille = court + (b >= nbBlocs - nbLongs ? 1 : 0);
    const bloc = donnees.slice(curseur, curseur + taille);
    curseur += taille;
    blocs.push({ donnees: bloc, correction: correction(bloc, nbCorrection) });
  }

  const sortie = [];
  const maxDonnees = Math.max(...blocs.map((b) => b.donnees.length));
  for (let k = 0; k < maxDonnees; k++) for (const b of blocs) if (k < b.donnees.length) sortie.push(b.donnees[k]);
  for (let k = 0; k < nbCorrection; k++) for (const b of blocs) sortie.push(b.correction[k]);
  return sortie;
}

// ------------------------------------------------------------- matrice

const LIBRE = null;

function squelette(version) {
  const taille = 17 + 4 * version;
  const m = Array.from({ length: taille }, () => new Array(taille).fill(LIBRE));
  const fonction = Array.from({ length: taille }, () => new Array(taille).fill(false));
  const poser = (r, c, v) => { m[r][c] = v; fonction[r][c] = true; };

  const motifRecherche = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= taille || cc >= taille) continue;
        const dedans = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const anneau = dedans && (r === 0 || r === 6 || c === 0 || c === 6);
        const coeur = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        poser(rr, cc, anneau || coeur ? 1 : 0);
      }
    }
  };
  motifRecherche(0, 0);
  motifRecherche(0, taille - 7);
  motifRecherche(taille - 7, 0);

  // Motifs de synchronisation.
  for (let i = 8; i < taille - 8; i++) {
    poser(6, i, i % 2 === 0 ? 1 : 0);
    poser(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Motifs d'alignement, hors coins occupés par les motifs de recherche.
  const centres = ALIGNEMENTS[version - 1];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === taille - 7) || (r === taille - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const bord = Math.max(Math.abs(dr), Math.abs(dc));
          poser(r + dr, c + dc, bord === 1 ? 0 : 1);
        }
      }
    }
  }

  // Module toujours sombre, et réservation des zones d'information.
  poser(taille - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === LIBRE) poser(8, i, 0);
    if (m[i][8] === LIBRE) poser(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][taille - 1 - i] === LIBRE) poser(8, taille - 1 - i, 0);
    if (m[taille - 1 - i][8] === LIBRE) poser(taille - 1 - i, 8, 0);
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        poser(i, taille - 11 + j, 0);
        poser(taille - 11 + j, i, 0);
      }
    }
  }
  return { m, fonction, taille };
}

/** Parcours en zigzag : deux colonnes à la fois, de la droite vers la gauche. */
export function* parcours(taille) {
  let montant = true;
  for (let droite = taille - 1; droite > 0; droite -= 2) {
    if (droite === 6) droite = 5; // la colonne de synchronisation est sautée
    for (let pas = 0; pas < taille; pas++) {
      const r = montant ? taille - 1 - pas : pas;
      for (const c of [droite, droite - 1]) yield [r, c];
    }
    montant = !montant;
  }
}

export const MASQUES = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function poserFormat(m, taille, niveau, masque) {
  const bits = bitsFormat(niveau, masque);
  const bit = (i) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

  for (let i = 0; i <= 7; i++) m[taille - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8][taille - 15 + i] = bit(i);
  m[taille - 8][8] = 1;
}

function poserVersion(m, taille, version) {
  if (version < 7) return;
  const bits = bitsVersion(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    m[Math.floor(i / 3)][taille - 11 + (i % 3)] = b;
    m[taille - 11 + (i % 3)][Math.floor(i / 3)] = b;
  }
}

/** Pénalités du standard : on retient le masque qui rend le code le plus lisible. */
export function penalite(m) {
  const n = m.length;
  let total = 0;

  const serie = (lire) => {
    for (let a = 0; a < n; a++) {
      let compte = 1;
      for (let b = 1; b < n; b++) {
        if (lire(a, b) === lire(a, b - 1)) compte += 1;
        else { if (compte >= 5) total += 3 + (compte - 5); compte = 1; }
      }
      if (compte >= 5) total += 3 + (compte - 5);
    }
  };
  serie((r, c) => m[r][c]);
  serie((c, r) => m[r][c]);

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) total += 3;
    }
  }

  const motif = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const inverse = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const cherche = (lire) => {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b + 11 <= n; b++) {
        const fenetre = Array.from({ length: 11 }, (_, k) => lire(a, b + k));
        if (motif.every((v, k) => v === fenetre[k]) || inverse.every((v, k) => v === fenetre[k])) total += 40;
      }
    }
  };
  cherche((r, c) => m[r][c]);
  cherche((c, r) => m[r][c]);

  const sombres = m.flat().filter((v) => v === 1).length;
  const proportion = (100 * sombres) / (n * n);
  total += 10 * Math.floor(Math.abs(proportion - 50) / 5);
  return total;
}

/**
 * @param {string} texte
 * @returns {{taille:number, version:number, masque:number, modules:number[][]}}
 * @throws si le texte dépasse la version 10 en niveau L.
 */
export function encoder(texte) {
  const octets = new TextEncoder().encode(texte);
  const version = versionPour(octets.length);
  if (version === null) throw new Error(`texte trop long pour un QR de version 10 : ${octets.length} octets`);

  const mots = motsFinaux(octets, version);
  const bits = [];
  for (const mot of mots) for (let k = 7; k >= 0; k--) bits.push((mot >> k) & 1);

  let meilleur = null;
  for (let masque = 0; masque < 8; masque++) {
    const { m, fonction, taille } = squelette(version);
    let i = 0;
    for (const [r, c] of parcours(taille)) {
      if (fonction[r][c]) continue;
      const b = i < bits.length ? bits[i] : 0;
      i += 1;
      m[r][c] = MASQUES[masque](r, c) ? b ^ 1 : b;
    }
    poserVersion(m, taille, version);
    poserFormat(m, taille, NIVEAU_L, masque);
    const score = penalite(m);
    if (meilleur === null || score < meilleur.score) meilleur = { score, modules: m, taille, masque };
  }
  return { taille: meilleur.taille, version, masque: meilleur.masque, modules: meilleur.modules };
}

/**
 * Rend le code en SVG. Le SVG est du texte : il ne charge rien, ne s'exécute
 * pas, et la politique de sécurité de la page l'accepte tel quel.
 */
export function versSvg(texte, { marge = 4, taillePixel = 4 } = {}) {
  const { modules, taille } = encoder(texte);
  const cote = (taille + 2 * marge) * taillePixel;
  const rectangles = [];
  for (let r = 0; r < taille; r++) {
    for (let c = 0; c < taille; c++) {
      if (modules[r][c] === 1) {
        rectangles.push(`M${(c + marge) * taillePixel} ${(r + marge) * taillePixel}h${taillePixel}v${taillePixel}h-${taillePixel}z`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cote}" height="${cote}" viewBox="0 0 ${cote} ${cote}" role="img" aria-label="Lien de la session en code QR">`,
    `<rect width="${cote}" height="${cote}" fill="#ffffff"/>`,
    `<path fill="#000000" d="${rectangles.join('')}"/>`,
    '</svg>',
  ].join('');
}
