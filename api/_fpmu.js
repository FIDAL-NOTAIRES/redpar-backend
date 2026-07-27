/**
 * REDPAR — accès à la base FPMU (DGFiP, personnes morales)
 * ========================================================
 * Lecture des fichiers parquet publiés par FIDAL-NOTAIRES/fpmu-data,
 * directement en HTTP, sans base de données ni binaire natif.
 *
 * Principe. Les fichiers sont TRIÉS PAR SIREN et découpés en groupes de
 * 100 000 lignes ; l'en-tête du parquet porte le min et le max de chaque
 * groupe. On lit donc d'abord le pied du fichier (~0,5 Mo), on repère le seul
 * groupe susceptible de contenir le SIREN, et on ne télécharge que celui-là.
 * Mesuré sur LOGIS METROPOLE : 2,9 Mo transférés sur 283,6 Mo de fichier.
 *
 * ⚠ Ne pas remplacer le tri par SIREN ni le partitionner par département sans
 * refaire cette mesure : c'est le tri qui rend l'interrogation possible.
 *
 * Variables d'environnement :
 *   FPMU_BASE_URL   base des fichiers (release GitHub), sans / final
 *   FPMU_MILLESIME  millésime, ex. 2025
 *   FPMU_MAX_LIGNES plafond de lignes renvoyées (défaut 20000)
 *
 * ATTENTION MÉTIER : donnée de PRÉ-CONTRÔLE, en situation au 1er janvier du
 * millésime. Seul le relevé de propriété ou l'état hypothécaire fait foi. Les
 * personnes physiques, entreprises individuelles et sociétés unipersonnelles
 * sont hors périmètre ; les simples locataires n'y figurent pas.
 */

const BASE = (process.env.FPMU_BASE_URL || '').replace(/\/+$/, '');
const MILLESIME = process.env.FPMU_MILLESIME || '2025';
const MAX_LIGNES = Number(process.env.FPMU_MAX_LIGNES || 20000);

const JEUX = {
  parcelles: {
    fichier: () => `parcelles-${MILLESIME}.parquet`,
    colonnes: ['numero_siren', 'code_departement', 'code_insee', 'nom_commune',
      'code_parcelle', 'adresse', 'nature_culture', 'contenance', 'code_droit',
      'denomination', 'forme_juridique'],
  },
  locaux: {
    fichier: () => `locaux-${MILLESIME}.parquet`,
    colonnes: ['numero_siren', 'code_departement', 'code_insee', 'nom_commune',
      'code_parcelle', 'batiment', 'entree', 'niveau', 'porte', 'adresse',
      'code_droit', 'denomination', 'forme_juridique'],
  },
  annuaire: {
    fichier: () => `annuaire-${MILLESIME}.parquet`,
    colonnes: ['numero_siren', 'denomination', 'denomination_norm',
      'forme_juridique', 'nb_parcelles', 'nb_locaux', 'contenance_m2'],
    // L'annuaire est trié par dénomination normalisée, pas par SIREN.
    cleTri: 'denomination_norm',
  },
};

// --------------------------------------------------------------------------
// Chargement paresseux des modules ESM depuis un fichier CommonJS, et cache
// des métadonnées entre invocations tièdes (une seule lecture du pied par
// conteneur, pas par requête).
// --------------------------------------------------------------------------
let libs;
function charger() {
  if (!libs) {
    libs = (async () => {
      const hp = await import('hyparquet');
      const { compressors } = await import('hyparquet-compressors');
      return { hp, compressors };
    })();
  }
  return libs;
}

const cache = new Map();

async function ouvrir(jeu) {
  if (!BASE) throw new Error('FPMU_BASE_URL non configurée');
  if (cache.has(jeu)) return cache.get(jeu);
  const promesse = (async () => {
    const { hp } = await charger();
    const url = `${BASE}/${JEUX[jeu].fichier()}`;
    const file = await hp.asyncBufferFromUrl({ url });
    const meta = await hp.parquetMetadataAsync(file);
    // Index des groupes : offset de départ, nombre de lignes, min et max de
    // la colonne de tri. Calculé une fois, réutilisé à chaque requête.
    const cle = JEUX[jeu].cleTri || 'numero_siren';
    const pos = meta.row_groups[0].columns
      .findIndex((c) => c.meta_data.path_in_schema.join('.') === cle);
    if (pos < 0) throw new Error(`colonne de tri « ${cle} » absente de ${url}`);
    let debut = 0;
    const groupes = meta.row_groups.map((rg) => {
      const n = Number(rg.num_rows);
      const st = rg.columns[pos].meta_data.statistics || {};
      const g = { debut, fin: debut + n, min: st.min_value, max: st.max_value };
      debut += n;
      return g;
    });
    return { file, meta, groupes, total: Number(meta.num_rows), url };
  })();
  cache.set(jeu, promesse);
  try {
    return await promesse;
  } catch (e) {
    cache.delete(jeu);            // ne pas figer un échec réseau
    throw e;
  }
}

// --------------------------------------------------------------------------
// Normalisation et lecture
// --------------------------------------------------------------------------

/** Même normalisation que celle appliquée à la construction de l'annuaire. */
function normaliser(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** JSON ne sait pas sérialiser un BigInt : les contenances en sont. */
function assainir(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

function ligneSaine(r) {
  const o = {};
  for (const k of Object.keys(r)) o[k] = assainir(r[k]);
  return o;
}

/**
 * Lit les lignes des groupes retenus par le prédicat d'élagage.
 * @param {(g:{min:string,max:string})=>boolean} garde
 * @param {(r:object)=>boolean} filtre
 */
async function lire(jeu, garde, filtre, limite) {
  const { file, groupes } = await ouvrir(jeu);
  const { hp, compressors } = await charger();
  const plafond = Math.min(limite || MAX_LIGNES, MAX_LIGNES);
  const retenus = groupes.filter(
    (g) => g.min === undefined || g.max === undefined || garde(g));
  const lignes = [];
  let groupesLus = 0;
  for (const g of retenus) {
    const data = await hp.parquetReadObjects({
      file, compressors, columns: JEUX[jeu].colonnes,
      rowStart: g.debut, rowEnd: g.fin,
    });
    groupesLus += 1;
    for (const r of data) {
      if (!filtre(r)) continue;
      if (lignes.length >= plafond) return { lignes, tronque: true, groupesLus, groupesTotal: groupes.length };
    lignes.push(ligneSaine(r));
    }
  }
  return { lignes, tronque: false, groupesLus, groupesTotal: groupes.length };
}

/** Recherche par SIREN, dans parcelles ou locaux. */
async function parSiren(jeu, siren, limite) {
  const s = String(siren).trim().toUpperCase();
  return lire(jeu, (g) => g.min <= s && s <= g.max,
    (r) => r.numero_siren === s, limite);
}

/**
 * Recherche par dénomination dans l'annuaire.
 *
 * ⚠ LIMITE ASSUMÉE : la recherche porte sur le DÉBUT de la dénomination
 * normalisée, seule forme que le tri du fichier permet d'élaguer. « LOGIS »
 * trouve LOGIS METROPOLE ; « METROPOLE » ne le trouve pas. Pour une recherche
 * en plein texte, passer par l'API Recherche d'Entreprises, qui reste le
 * chemin normal d'identification de la société dans REDPAR.
 */
async function parNom(nom, limite) {
  const q = normaliser(nom);
  if (!q) return { lignes: [], tronque: false, groupesLus: 0, groupesTotal: 0 };
  const borne = `${q}\uffff`;
  return lire('annuaire',
    (g) => !(g.max < q || g.min > borne),
    (r) => String(r.denomination_norm || '').startsWith(q), limite);
}

// --------------------------------------------------------------------------
// Mise en forme des réponses
// --------------------------------------------------------------------------

const AVERTISSEMENT = 'Donnée de pré-contrôle, situation au 1er janvier '
  + `${MILLESIME}. Seul le relevé de propriété ou l'état hypothécaire fait foi. `
  + 'Personnes physiques, entreprises individuelles et sociétés '
  + 'unipersonnelles hors périmètre ; simples locataires absents. '
  + 'Source DGFiP, Licence Ouverte 2.0.';

/** Agrégats communs aux deux jeux, calculés sur les lignes renvoyées. */
function agreger(lignes, avecSurface) {
  const communes = new Set(), departements = new Set(), biens = new Set();
  let m2 = 0;
  for (const r of lignes) {
    if (r.code_insee) communes.add(r.code_insee);
    if (r.code_departement) departements.add(r.code_departement);
    if (r.code_parcelle) biens.add(r.code_parcelle);
  }
  // La surface se somme sur les PARCELLES DISTINCTES : une parcelle apparaît
  // autant de fois qu'elle a de titulaires de droits, sommer les lignes la
  // compterait plusieurs fois.
  if (avecSurface) {
    const vues = new Set();
    for (const r of lignes) {
      if (!r.code_parcelle || vues.has(r.code_parcelle)) continue;
      vues.add(r.code_parcelle);
      m2 += Number(r.contenance || 0);
    }
  }
  return {
    nb_communes: communes.size,
    nb_departements: departements.size,
    nb_biens_distincts: biens.size,
    ...(avecSurface ? { contenance_totale_m2: m2 } : {}),
  };
}

function repondre(res, code, corps) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.status(code).send(JSON.stringify(corps));
}

function erreur(res, code, message) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).send(JSON.stringify({ erreur: message }));
}

module.exports = {
  MILLESIME, MAX_LIGNES, AVERTISSEMENT,
  parSiren, parNom, normaliser, agreger, repondre, erreur, ouvrir,
};
