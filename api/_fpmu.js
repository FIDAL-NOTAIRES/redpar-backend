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

// Libellés de département et de région. Table en dur : 101 entrées stables,
// aucun appel réseau à l'exécution. Les fichiers DGFiP ne portent que le code.
const DEPARTEMENTS = {
  '01': ['Ain', 'Auvergne-Rhône-Alpes'],
  '02': ['Aisne', 'Hauts-de-France'],
  '03': ['Allier', 'Auvergne-Rhône-Alpes'],
  '04': ['Alpes-de-Haute-Provence', "Provence-Alpes-Côte d'Azur"],
  '05': ['Hautes-Alpes', "Provence-Alpes-Côte d'Azur"],
  '06': ['Alpes-Maritimes', "Provence-Alpes-Côte d'Azur"],
  '07': ['Ardèche', 'Auvergne-Rhône-Alpes'],
  '08': ['Ardennes', 'Grand Est'],
  '09': ['Ariège', 'Occitanie'],
  '10': ['Aube', 'Grand Est'],
  '11': ['Aude', 'Occitanie'],
  '12': ['Aveyron', 'Occitanie'],
  '13': ['Bouches-du-Rhône', "Provence-Alpes-Côte d'Azur"],
  '14': ['Calvados', 'Normandie'],
  '15': ['Cantal', 'Auvergne-Rhône-Alpes'],
  '16': ['Charente', 'Nouvelle-Aquitaine'],
  '17': ['Charente-Maritime', 'Nouvelle-Aquitaine'],
  '18': ['Cher', 'Centre-Val de Loire'],
  '19': ['Corrèze', 'Nouvelle-Aquitaine'],
  '2A': ['Corse-du-Sud', 'Corse'],
  '2B': ['Haute-Corse', 'Corse'],
  '21': ["Côte-d'Or", 'Bourgogne-Franche-Comté'],
  '22': ["Côtes-d'Armor", 'Bretagne'],
  '23': ['Creuse', 'Nouvelle-Aquitaine'],
  '24': ['Dordogne', 'Nouvelle-Aquitaine'],
  '25': ['Doubs', 'Bourgogne-Franche-Comté'],
  '26': ['Drôme', 'Auvergne-Rhône-Alpes'],
  '27': ['Eure', 'Normandie'],
  '28': ['Eure-et-Loir', 'Centre-Val de Loire'],
  '29': ['Finistère', 'Bretagne'],
  '30': ['Gard', 'Occitanie'],
  '31': ['Haute-Garonne', 'Occitanie'],
  '32': ['Gers', 'Occitanie'],
  '33': ['Gironde', 'Nouvelle-Aquitaine'],
  '34': ['Hérault', 'Occitanie'],
  '35': ['Ille-et-Vilaine', 'Bretagne'],
  '36': ['Indre', 'Centre-Val de Loire'],
  '37': ['Indre-et-Loire', 'Centre-Val de Loire'],
  '38': ['Isère', 'Auvergne-Rhône-Alpes'],
  '39': ['Jura', 'Bourgogne-Franche-Comté'],
  '40': ['Landes', 'Nouvelle-Aquitaine'],
  '41': ['Loir-et-Cher', 'Centre-Val de Loire'],
  '42': ['Loire', 'Auvergne-Rhône-Alpes'],
  '43': ['Haute-Loire', 'Auvergne-Rhône-Alpes'],
  '44': ['Loire-Atlantique', 'Pays de la Loire'],
  '45': ['Loiret', 'Centre-Val de Loire'],
  '46': ['Lot', 'Occitanie'],
  '47': ['Lot-et-Garonne', 'Nouvelle-Aquitaine'],
  '48': ['Lozère', 'Occitanie'],
  '49': ['Maine-et-Loire', 'Pays de la Loire'],
  '50': ['Manche', 'Normandie'],
  '51': ['Marne', 'Grand Est'],
  '52': ['Haute-Marne', 'Grand Est'],
  '53': ['Mayenne', 'Pays de la Loire'],
  '54': ['Meurthe-et-Moselle', 'Grand Est'],
  '55': ['Meuse', 'Grand Est'],
  '56': ['Morbihan', 'Bretagne'],
  '57': ['Moselle', 'Grand Est'],
  '58': ['Nièvre', 'Bourgogne-Franche-Comté'],
  '59': ['Nord', 'Hauts-de-France'],
  '60': ['Oise', 'Hauts-de-France'],
  '61': ['Orne', 'Normandie'],
  '62': ['Pas-de-Calais', 'Hauts-de-France'],
  '63': ['Puy-de-Dôme', 'Auvergne-Rhône-Alpes'],
  '64': ['Pyrénées-Atlantiques', 'Nouvelle-Aquitaine'],
  '65': ['Hautes-Pyrénées', 'Occitanie'],
  '66': ['Pyrénées-Orientales', 'Occitanie'],
  '67': ['Bas-Rhin', 'Grand Est'],
  '68': ['Haut-Rhin', 'Grand Est'],
  '69': ['Rhône', 'Auvergne-Rhône-Alpes'],
  '70': ['Haute-Saône', 'Bourgogne-Franche-Comté'],
  '71': ['Saône-et-Loire', 'Bourgogne-Franche-Comté'],
  '72': ['Sarthe', 'Pays de la Loire'],
  '73': ['Savoie', 'Auvergne-Rhône-Alpes'],
  '74': ['Haute-Savoie', 'Auvergne-Rhône-Alpes'],
  '75': ['Paris', 'Île-de-France'],
  '76': ['Seine-Maritime', 'Normandie'],
  '77': ['Seine-et-Marne', 'Île-de-France'],
  '78': ['Yvelines', 'Île-de-France'],
  '79': ['Deux-Sèvres', 'Nouvelle-Aquitaine'],
  '80': ['Somme', 'Hauts-de-France'],
  '81': ['Tarn', 'Occitanie'],
  '82': ['Tarn-et-Garonne', 'Occitanie'],
  '83': ['Var', "Provence-Alpes-Côte d'Azur"],
  '84': ['Vaucluse', "Provence-Alpes-Côte d'Azur"],
  '85': ['Vendée', 'Pays de la Loire'],
  '86': ['Vienne', 'Nouvelle-Aquitaine'],
  '87': ['Haute-Vienne', 'Nouvelle-Aquitaine'],
  '88': ['Vosges', 'Grand Est'],
  '89': ['Yonne', 'Bourgogne-Franche-Comté'],
  '90': ['Territoire de Belfort', 'Bourgogne-Franche-Comté'],
  '91': ['Essonne', 'Île-de-France'],
  '92': ['Hauts-de-Seine', 'Île-de-France'],
  '93': ['Seine-Saint-Denis', 'Île-de-France'],
  '94': ['Val-de-Marne', 'Île-de-France'],
  '95': ["Val-d'Oise", 'Île-de-France'],
  '971': ['Guadeloupe', 'Guadeloupe'],
  '972': ['Martinique', 'Martinique'],
  '973': ['Guyane', 'Guyane'],
  '974': ['La Réunion', 'La Réunion'],
  '976': ['Mayotte', 'Mayotte'],
};

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

function cors(res) {
  // Même politique que api/search.js, en place depuis l'origine du projet :
  // le frontend est servi depuis un autre domaine que le backend, donc chaque
  // réponse doit porter ces en-têtes, y compris les réponses d'erreur et la
  // requête préparatoire OPTIONS. Sans eux, le navigateur bloque l'appel avant
  // d'en lire le corps et n'affiche qu'un « Failed to fetch » opaque.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function repondre(res, code, corps) {
  cors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.status(code).send(JSON.stringify(corps));
}

function erreur(res, code, message) {
  cors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).send(JSON.stringify({ erreur: message }));
}

/**
 * Traduction vers la forme historique consommée par le frontend REDPAR :
 * champs en camelCase, libellés de département et de région.
 *
 * ⚠ « coordonnees » reste NULLE : les fichiers DGFiP ne géocodent rien, alors
 * que le miroir Koumoul le faisait. Ne pas y mettre le centroïde de la commune
 * pour « faire marcher la carte » : la vue satellite du frontend pointe au
 * zoom 19, et afficher le centre du village à la place de la parcelle serait
 * un contresens dans un outil notarial. Le géocodage à la parcelle est un
 * chantier distinct (cadastre Etalab).
 */
function versFrontend(r) {
  const [nomDept, region] = DEPARTEMENTS[r.code_departement] || [r.code_departement, ''];
  return {
    codeParcelle: r.code_parcelle,
    commune: r.nom_commune,
    codeInsee: r.code_insee,
    departement: nomDept,
    codeDepartement: r.code_departement,
    region,
    adresse: r.adresse,
    contenance: r.contenance,
    natureCulture: r.nature_culture,
    codeDroit: r.code_droit,
    denomination: r.denomination,
    formeJuridique: r.forme_juridique,
    numeroSiren: r.numero_siren,
    coordonnees: null,
    // Propre aux locaux
    batiment: r.batiment,
    entree: r.entree,
    niveau: r.niveau,
    porte: r.porte,
  };
}

module.exports = {
  MILLESIME, MAX_LIGNES, AVERTISSEMENT,
  parSiren, parNom, normaliser, agreger, repondre, erreur, ouvrir,
  versFrontend, DEPARTEMENTS, cors,
};
