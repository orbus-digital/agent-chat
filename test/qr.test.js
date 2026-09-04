/**
 * L'encodeur QR, éprouvé par un décodeur écrit ici — pas par un coup d'œil.
 *
 * Un QR faux est pire que pas de QR : il s'affiche, il a l'air d'un QR, et il
 * ne mène nulle part. Trois garde-fous indépendants, donc :
 *   — les informations de format et de version sont comparées aux valeurs
 *     publiées par la norme (ISO/IEC 18004, tables C.1 et D.1) ;
 *   — les mots de correction sont vérifiés par leurs syndromes, calculés en
 *     évaluant le polynôme reçu, ce que l'encodeur ne fait jamais ;
 *   — le code est relu module par module et doit rendre le texte de départ.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encoder, versSvg, bitsFormat, bitsVersion, correction, capaciteOctets, versionPour } from '../web/js/qr.js';

/** Table C.1 de la norme, niveau L, masques 0 à 7. */
const FORMATS_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
/** Table D.1 de la norme, versions 7 à 10. */
const VERSIONS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

// ------------------------------------------------------------ décodeur

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Syndromes du mot de code : pour un mot valide, tous nuls.
 * Cette vérification n'emprunte rien à l'encodeur — elle évalue le polynôme
 * reçu en α¹ … αⁿ au lieu d'en refaire la division.
 */
function syndromes(mot, nbCorrection) {
  const out = [];
  for (let i = 0; i < nbCorrection; i++) {
    let s = 0;
    for (const octet of mot) s = mul(s, EXP[i]) ^ octet;
    out.push(s);
  }
  return out;
}

const MASQUES = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
const ALIGNEMENTS = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MOTS_TOTAUX = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const CORRECTION_PAR_BLOC = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4];

/** Carte des modules de service, redéduite ici des règles de la norme. */
function carteFonctions(version) {
  const n = 17 + 4 * version;
  const f = Array.from({ length: n }, () => new Array(n).fill(false));
  const bloc = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) f[r][c] = true;
  };
  bloc(0, 0, 9, 9);
  bloc(0, n - 8, 9, 8);
  bloc(n - 8, 0, 8, 9);
  for (let i = 0; i < n; i++) { f[6][i] = true; f[i][6] = true; }
  const centres = ALIGNEMENTS[version - 1];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      bloc(r - 2, c - 2, 5, 5);
    }
  }
  if (version >= 7) { bloc(0, n - 11, 6, 3); bloc(n - 11, 0, 3, 6); }
  return f;
}

function* parcours(n) {
  let montant = true;
  for (let droite = n - 1; droite > 0; droite -= 2) {
    if (droite === 6) droite = 5;
    for (let pas = 0; pas < n; pas++) {
      const r = montant ? n - 1 - pas : pas;
      for (const c of [droite, droite - 1]) yield [r, c];
    }
    montant = !montant;
  }
}

/** Relit un code complet et rend { texte, masque, blocs }. */
function decoder({ modules, taille, version }) {
  // Le masque est lu dans l'information de format, comme le ferait un lecteur.
  let masque = null;
  for (let m = 0; m < 8; m++) {
    const bits = bitsFormat(0b01, m);
    const lu = [];
    for (let i = 0; i <= 5; i++) lu.push(modules[8][i]);
    lu.push(modules[8][7], modules[8][8], modules[7][8]);
    for (let i = 9; i <= 14; i++) lu.push(modules[14 - i][8]);
    if (lu.every((b, i) => b === ((bits >> i) & 1))) { masque = m; break; }
  }
  assert.notEqual(masque, null, 'information de format illisible');

  const fonctions = carteFonctions(version);
  const bits = [];
  for (const [r, c] of parcours(taille)) {
    if (fonctions[r][c]) continue;
    bits.push(MASQUES[masque](r, c) ? modules[r][c] ^ 1 : modules[r][c]);
  }

  const mots = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) mots.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const i = version - 1;
  const nbBlocs = BLOCS[i];
  const nbCorrection = CORRECTION_PAR_BLOC[i];
  const totalDonnees = MOTS_TOTAUX[i] - nbCorrection * nbBlocs;
  const court = Math.floor(totalDonnees / nbBlocs);
  const nbLongs = totalDonnees % nbBlocs;
  const tailles = Array.from({ length: nbBlocs }, (_, b) => court + (b >= nbBlocs - nbLongs ? 1 : 0));

  // Dés-entrelacement, exactement à l'inverse de l'écriture.
  const donnees = tailles.map(() => []);
  let curseur = 0;
  for (let k = 0; k < Math.max(...tailles); k++) {
    for (let b = 0; b < nbBlocs; b++) if (k < tailles[b]) donnees[b].push(mots[curseur++]);
  }
  const corrections = tailles.map(() => []);
  for (let k = 0; k < nbCorrection; k++) for (let b = 0; b < nbBlocs; b++) corrections[b].push(mots[curseur++]);

  const flux = donnees.flat();
  const lireBits = (debut, n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const octet = flux[Math.floor((debut + k) / 8)];
      v = (v << 1) | ((octet >> (7 - ((debut + k) % 8))) & 1);
    }
    return v;
  };
  assert.equal(lireBits(0, 4), 0b0100, 'mode octet attendu');
  const bitsLongueur = version < 10 ? 8 : 16;
  const longueur = lireBits(4, bitsLongueur);
  const octets = [];
  for (let k = 0; k < longueur; k++) octets.push(lireBits(4 + bitsLongueur + 8 * k, 8));

  return {
    texte: new TextDecoder().decode(Uint8Array.from(octets)),
    masque,
    blocs: donnees.map((d, b) => [...d, ...corrections[b]]),
    nbCorrection,
  };
}

// -------------------------------------------------------------- tests

describe('qr — conformité aux tables de la norme', () => {
  test('les huit informations de format du niveau L sont exactes', () => {
    assert.deepEqual(FORMATS_L.map((_, i) => bitsFormat(0b01, i)), FORMATS_L);
  });

  test('les informations de version 7 à 10 sont exactes', () => {
    for (const [v, attendu] of Object.entries(VERSIONS)) assert.equal(bitsVersion(Number(v)), attendu);
  });

  test('la correction d\'un bloc a exactement la longueur demandée', () => {
    assert.equal(correction([1, 2, 3], 10).length, 10);
    assert.equal(correction(new Array(19).fill(0), 7).length, 7);
  });
});

describe('qr — capacité et choix de version', () => {
  test('la capacité croît avec la version', () => {
    const capacites = Array.from({ length: 10 }, (_, i) => capaciteOctets(i + 1));
    for (let i = 1; i < capacites.length; i++) assert.ok(capacites[i] > capacites[i - 1]);
    assert.equal(capaciteOctets(1), 17);
  });

  test('la plus petite version suffisante est choisie', () => {
    assert.equal(versionPour(10), 1);
    assert.equal(versionPour(capaciteOctets(1) + 1), 2);
    assert.equal(versionPour(capaciteOctets(10)), 10);
    assert.equal(versionPour(capaciteOctets(10) + 1), null);
  });

  test('un texte trop long est refusé plutôt que tronqué', () => {
    assert.throws(() => encoder('x'.repeat(400)), /trop long/);
  });
});

describe('qr — structure du code', () => {
  const { modules, taille, version } = encoder('https://exemple.test/#t=ac-0123456789012345678901234567890&k=' + 'A'.repeat(43));

  test('la taille suit la version', () => {
    assert.equal(taille, 17 + 4 * version);
  });

  test('aucun module n\'est resté indéterminé', () => {
    assert.equal(modules.flat().every((v) => v === 0 || v === 1), true);
  });

  test('les trois motifs de recherche sont en place', () => {
    for (const [r0, c0] of [[0, 0], [0, taille - 7], [taille - 7, 0]]) {
      assert.equal(modules[r0][c0], 1);
      assert.equal(modules[r0 + 1][c0 + 1], 0);
      assert.equal(modules[r0 + 3][c0 + 3], 1);
      assert.equal(modules[r0 + 6][c0 + 6], 1);
    }
    assert.notEqual(modules[3][3], modules[3][1]);
  });

  test('les motifs de synchronisation alternent', () => {
    for (let i = 8; i < taille - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `ligne ${i}`);
      assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `colonne ${i}`);
    }
  });

  test('le module toujours sombre est sombre', () => {
    assert.equal(modules[taille - 8][8], 1);
  });
});

describe('qr — aller-retour complet', () => {
  const cas = [
    'a',
    'https://exemple.test/chat/',
    'https://exemple.test/chat/#t=ac-0123456789012345678901234567890&k=' + 'A'.repeat(43),
    'https://exemple.test/chat/#t=ac-0123456789012345678901234567890&k=' + 'A'.repeat(43) + '&ro=1',
    'accentué — ça compte aussi 👀',
    'x'.repeat(200),
  ];

  for (const texte of cas) {
    test(`« ${texte.slice(0, 40)}${texte.length > 40 ? '…' : ''} » se relit à l'identique`, () => {
      const code = encoder(texte);
      const lu = decoder(code);
      assert.equal(lu.texte, texte);
      assert.equal(lu.masque, code.masque, 'le masque annoncé n\'est pas celui appliqué');
    });

    test(`« ${texte.slice(0, 20)}… » a des mots de correction valides`, () => {
      const { blocs, nbCorrection } = decoder(encoder(texte));
      for (const [i, bloc] of blocs.entries()) {
        assert.deepEqual(syndromes(bloc, nbCorrection), new Array(nbCorrection).fill(0), `bloc ${i}`);
      }
    });
  }

  test('un module retourné casse les syndromes — la vérification a bien du mordant', () => {
    const code = encoder('https://exemple.test/chat/#t=ac-0123456789012345678901234567890&k=' + 'A'.repeat(43));
    const abime = { ...code, modules: code.modules.map((l) => [...l]) };
    // Un module de données, loin des zones de service.
    abime.modules[20][20] ^= 1;
    const { blocs, nbCorrection } = decoder(abime);
    assert.equal(blocs.some((b) => syndromes(b, nbCorrection).some((s) => s !== 0)), true);
  });
});

describe('qr — rendu SVG', () => {
  const svg = versSvg('https://exemple.test/chat/#t=ac-0123456789012345678901234567890&k=' + 'A'.repeat(43));

  test('c\'est un SVG autonome, sans script ni ressource externe', () => {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>$/);
    assert.equal(/<script|href=|xlink|onload/.test(svg), false, 'le SVG charge ou exécute quelque chose');
  });

  test('il porte un texte de remplacement, pour qui ne voit pas l\'image', () => {
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label="[^"]+"/);
  });

  test('la marge silencieuse réglementaire de 4 modules est présente', () => {
    const { taille } = encoder('https://exemple.test/chat/#t=ac-0123456789012345678901234567890&k=' + 'A'.repeat(43));
    const cote = Number(svg.match(/width="(\d+)"/)[1]);
    assert.equal(cote, (taille + 8) * 4);
  });
});
