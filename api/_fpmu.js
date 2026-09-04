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

// Nomenclature des catégories juridiques de l'INSEE. Les fichiers DGFiP ne
// portent que le CODE : 6540 plutôt que « Société civile immobilière ».
// Cette table couvre les 123 codes présents dans la base au millésime 2025,
// soit 99,96 % des enregistrements ; les autres retombent sur le niveau II
// ci-dessous, qui est simplement les deux premiers chiffres du code — un
// libellé reste donc toujours affiché, même pour un code inconnu ou futur.
// Source : https://xml.insee.fr/schema/cj-enum.html, complétée des libellés
// révisés publiés par l'INSEE (7344 Métropole, « Commune et commune
// nouvelle », « Commune associée et commune déléguée »).
const CJ_NIVEAU_III = {
  '6540': "Société civile immobilière",
  '7210': "Commune et commune nouvelle",
  '4140': "Établissement public local à caractère industriel ou commercial",
  '5599': "Autre SA à conseil d'administration",
  '5546': "SA de HLM à conseil d'administration",
  '5710': "Société par actions simplifiée (SAS)",
  '9900': "Autre personne morale de droit privé",
  '5699': "Société anonyme par actions simplifiées",
  '6599': "Autre société civile",
  '6534': "Groupement foncier agricole",
  '5499': "Autre société à responsabilité limitée",
  '7113': "Ministère",
  '5515': "SA d'économie mixte à conseil d'administration",
  '7220': "Département",
  '9220': "Association déclarée",
  '6536': "Groupement forestier",
  '5646': "Société anonyme de HLM à directoire",
  '4110': "Établissement public national à caractère industriel ou commercial doté d'un comptable public",
  '7229': "(Autre) Collectivité territoriale",
  '6597': "Société civile d'exploitation agricole",
  '5560': "Autre SA coopérative à conseil d'administration",
  '7346': "Communauté de communes",
  '6598': "Exploitation agricole à responsabilité limitée",
  '5202': "Société en nom collectif",
  '7313': "Section de commune",
  '5615': "SA d'économie mixte à directoire",
  '7348': "Communauté d'agglomération",
  '6533': "Groupement agricole d'exploitation en commun (GAEC)",
  '7344': "Métropole",
  '6541': "Société civile immobilière de construction vente",
  '7389': "Établissement public national à caractère administratif",
  '6538': "Groupement foncier rural",
  '4120': "Établissement public national à caractère industriel ou commercial non doté d'un comptable public",
  '7364': "Établissement d'hospitalisation",
  '5547': "SA coopérative de production de HLM à conseil d'administration",
  '7230': "Région",
  '8130': "Institution de retraite complémentaire",
  '7150': "Service du ministère de la Défense",
  '9300': "Fondation",
  '9110': "Syndicat de copropriété",
  '7354': "Syndicat mixte communal",
  '6521': "Société civile de placement collectif immobilier (SCPI)",
  '6317': "Société coopérative agricole",
  '7343': "Communauté urbaine",
  '5510': "SA nationale à conseil d'administration",
  '7355': "Autre syndicat mixte",
  '9230': "Association déclarée reconnue d'utilité publique",
  '7490': "Autre personne morale de droit administratif",
  '5530': "Safer anonyme à conseil d'administration",
  '7361': "Centre communal d'action sociale",
  '7172': "Service déconcentré de l'État à compétence (inter) départementale",
  '7323': "Association foncière de remembrement",
  '3220': "Société étrangère non immatriculée au RCS",
  '7353': "Syndicat intercommunal à vocation unique (SIVU)",
  '5532': "Société anonyme mixte d'intérêt collectif agricole (SICA) à conseil d'administration",
  '5308': "Société en commandite par actions",
  '7171': "Service déconcentré de l'État à compétence (inter) régionale",
  '7371': "Office public d'habitation à loyer modéré (OPHLM)",
  '7345': "Syndicat intercommunal à vocation multiple (SIVOM)",
  '7385': "Autre établissement public national administratif à compétence territoriale limitée",
  '7366': "Établissement public local social et médico-social",
  '9260': "Association de droit local",
  '7381': "Organisme consulaire",
  '7321': "Association syndicale autorisée",
  '6596': "Caisse de crédit agricole mutuel",
  '5195': "Association coopérative inscrite (droit local Alsace Moselle)",
  '8210': "Mutuelle",
  '3120': "Société étrangère immatriculée au RCS",
  '7379': "(Autre) Établissement public administratif local",
  '5520': "Société d'investissement à capital variable (SICAV) à conseil d'administration",
  '3290': "(Autre) personne morale de droit étranger",
  '7383': "Établissement public national à caractère scientifique culturel et professionnel",
  '5460': "Autre SARL coopérative",
  '6411': "Société d'assurance mutuelle",
  '5660': "(Autre) SA coopérative à directoire",
  '8110': "Régime général de la sécurité sociale",
  '5306': "Société en commandite simple",
  '9240': "Congrégation",
  '7331': "Établissement public local d'enseignement",
  '6542': "Société civile d'attribution",
  '7372': "Service départemental d'incendie",
  '6535': "Groupement agricole foncier",
  '6220': "Groupement d'intérêt économique (GIE)",
  '6539': "Société civile foncière",
  '5485': "Société d'exercice libéral à responsabilité limitée",
  '7356': "Commission syndicale pour la gestion des biens indivis des communes",
  '5522': "Société anonyme immobilière pour le commerce et l'industrie (SICOMI) à conseil d'administration",
  '8250': "Assurance mutuelle agricole",
  '8310': "Comité central d'entreprise",
  '6318': "Union de sociétés coopératives agricoles",
  '4150': "Régie d'une collectivité locale à caractère industriel ou commercial",
  '7120': "Service central d'un ministère",
  '8120': "Régime spécial de sécurité sociale",
  '9150': "Association syndicale libre",
  '7179': "(Autre) Service déconcentré de l'État à compétence territoriale",
  '5192': "Société coopérative de banque populaire",
  '6316': "Coopérative d'utilisation de matériel agricole en commun (CUMA)",
  '4160': "Institution Banque de France",
  '7430': "Établissement public des cultes d'Alsace-Lorraine",
  '5558': "SA coopérative ouvrière de production (SCOP) à conseil d'administration",
  '5800': "Société européenne",
  '7410': "Groupement d'intérêt public (GIP)",
  '6595': "Caisse (locale) de crédit mutuel",
  '8490': "Autre organisme professionnel",
  '7312': "Commune associée et commune déléguée",
  '5630': "Safer anonyme à directoire",
  '5410': "SARL nationale",
  '6560': "Autre société civile coopérative",
  '5415': "SARL d'économie mixte",
  '7384': "Autre établissement public national d'enseignement",
  '6901': "Autres personnes de droit privé inscrites au registre du commerce et des sociétés",
  '5196': "Caisse d'épargne et de prévoyance à forme coopérative",
  '5651': "SA coopérative de consommation à directoire",
  '3210': "État collectivité ou établissement public étranger",
  '7351': "Institution interdépartementale ou entente",
  '8140': "Mutualité sociale agricole",
  '6589': "Société civile de moyens",
  '6532': "Société civile d'intérêt collectif agricole (SICA)",
  '7225': "Territoire d'Outre-Mer",
  '8311': "Comité d'établissement",
  '8450': "Ordre professionnel ou assimilé",
  '8420': "Syndicat patronal",
  '5458': "SARL coopérative ouvrière de production (SCOP)",
};

// Niveau II : repli, et garantie qu'aucun code ne reste sans libellé.
const CJ_NIVEAU_II = {
  '21': "Indivision",
  '22': "Société créée de fait",
  '23': "Société en participation",
  '24': "Fiducie",
  '27': "Paroisse hors zone concordataire",
  '29': "Autre groupement de droit privé non doté de la personnalité morale",
  '31': "Personne morale de droit étranger immatriculée au RCS",
  '32': "Personne morale de droit étranger non immatriculée au RCS",
  '41': "Établissement public ou régie à caractère industriel ou commercial",
  '51': "Société coopérative commerciale particulière",
  '52': "Société en nom collectif",
  '53': "Société en commandite",
  '54': "Société à responsabilité limitée (SARL)",
  '55': "Société anonyme à conseil d'administration",
  '56': "Société anonyme à directoire",
  '57': "Société anonyme par actions simplifiées",
  '58': "Société européenne",
  '61': "Caisse d'épargne et de prévoyance",
  '62': "Groupement d'intérêt économique",
  '63': "Société coopérative agricole",
  '64': "Société non commerciale d'assurances",
  '65': "Société civile",
  '69': "Autres personnes de droit privé inscrites au registre du commerce et des sociétés",
  '71': "Administration de l'État",
  '72': "Collectivité territoriale",
  '73': "Établissement public administratif",
  '74': "Autre personne morale de droit public administratif",
  '81': "Organisme gérant un régime de protection sociale à adhésion obligatoire",
  '82': "Organisme mutualiste",
  '83': "Comité d'entreprise",
  '84': "Organisme professionnel",
  '91': "Syndicat de propriétaires",
  '92': "Association loi 1901 ou assimilé",
  '93': "Fondation",
  '99': "Autre personne morale de droit privé",
};

/** Libellé d'une catégorie juridique : exact si connu, sinon niveau II. */
function libelleFormeJuridique(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  if (CJ_NIVEAU_III[c]) return CJ_NIVEAU_III[c];
  const n2 = CJ_NIVEAU_II[c.slice(0, 2)];
  return n2 ? `${n2} (code ${c})` : `Catégorie juridique ${c}`;
}

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
  // INDEX INVERSE — ajouté le 03/09/2026 (addendum REDPAR v11, § 5 d).
  // Mêmes lignes que « parcelles », TRIÉES PAR code_parcelle : il répond à
  // « qui détient cette parcelle ? », question que le tri par SIREN ne permet
  // pas sans tout lire. Le code commençant par l'INSEE, toute une commune est
  // un bloc contigu du fichier — un groupe de lignes sert tout un dossier.
  // Usage : parcelle d'assiette d'un lot de copropriété → son syndicat
  // (groupe_personne 7) → ses parcelles → l'assiette entière.
  proprietaires: {
    fichier: () => `proprietaires-${MILLESIME}.parquet`,
    colonnes: ['code_parcelle', 'code_insee', 'code_departement', 'nom_commune',
      'adresse', 'contenance', 'numero_siren', 'numero_majic',
      'groupe_personne', 'code_droit', 'denomination', 'forme_juridique'],
    cleTri: 'code_parcelle',
  },
};

// Colonnes ajoutées au millésime 2026 dans parcelles et locaux. Elles sont
// demandées SI le fichier les porte (voir colonnesPresentes) : le même code
// sert les releases 2025 (sans) et 2026 (avec).
const COLONNES_OPTIONNELLES = ['numero_majic', 'groupe_personne'];

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
    // Colonnes RÉELLEMENT présentes : demander à hyparquet une colonne absente
    // du schéma ferait échouer la lecture. On intersecte donc la liste voulue
    // avec le schéma lu, ce qui permet d'ajouter des colonnes d'un millésime à
    // l'autre sans casser la lecture des releases antérieures.
    const presentes = new Set(meta.row_groups[0].columns
      .map((c) => c.meta_data.path_in_schema.join('.')));
    const voulues = [...JEUX[jeu].colonnes,
      ...(jeu === 'proprietaires' ? [] : COLONNES_OPTIONNELLES)];
    const colonnes = voulues.filter((c) => presentes.has(c));
    let debut = 0;
    const groupes = meta.row_groups.map((rg) => {
      const n = Number(rg.num_rows);
      const st = rg.columns[pos].meta_data.statistics || {};
      const g = { debut, fin: debut + n, min: st.min_value, max: st.max_value };
      debut += n;
      return g;
    });
    return { file, meta, groupes, colonnes, total: Number(meta.num_rows), url };
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
  const { file, groupes, colonnes } = await ouvrir(jeu);
  const { hp, compressors } = await charger();
  const plafond = Math.min(limite || MAX_LIGNES, MAX_LIGNES);
  const retenus = groupes.filter(
    (g) => g.min === undefined || g.max === undefined || garde(g));
  const lignes = [];
  let groupesLus = 0;
  let correspondances = 0;      // toutes les lignes qui correspondent...
  for (const g of retenus) {
    const data = await hp.parquetReadObjects({
      file, compressors, columns: colonnes,
      rowStart: g.debut, rowEnd: g.fin,
    });
    groupesLus += 1;
    for (const r of data) {
      if (!filtre(r)) continue;
      correspondances += 1;
      // ...même au-delà du plafond : on cesse de les RENVOYER, on ne cesse pas
      // de les COMPTER. Sans quoi un gros bailleur verrait « 20 000 biens »
      // sans savoir qu'il en détient 45 000 — une troncature muette est un
      // contresens dans un relevé de patrimoine.
      if (lignes.length < plafond) lignes.push(ligneSaine(r));
    }
  }
  return {
    lignes,
    correspondances,
    tronque: correspondances > lignes.length,
    groupesLus,
    groupesTotal: groupes.length,
  };
}

/** Recherche par SIREN, dans parcelles ou locaux. */
async function parSiren(jeu, siren, limite) {
  const s = String(siren).trim().toUpperCase();
  return lire(jeu, (g) => g.min <= s && s <= g.max,
    (r) => r.numero_siren === s, limite);
}

/**
 * Recherche INVERSE : les titulaires de droits d'un ensemble de parcelles.
 * @param {string[]} codes  références à 14 caractères
 * Élagage : un groupe est lu s'il chevauche l'intervalle [min, max] des codes
 * demandés — les codes d'un même dossier sont voisins dans le tri, le plus
 * souvent dans un seul groupe. Le filtre exact est fait sur l'ensemble.
 */
async function parParcelles(codes, limite) {
  const ens = new Set((codes || []).map((c) => String(c).trim().toUpperCase())
    .filter((c) => c.length === 14));
  if (!ens.size) return { lignes: [], correspondances: 0, tronque: false, groupesLus: 0, groupesTotal: 0 };
  const tries = [...ens].sort();
  const bas = tries[0], haut = tries[tries.length - 1];
  return lire('proprietaires',
    (g) => !(g.max < bas || g.min > haut) && tries.some((c) => g.min <= c && c <= g.max),
    (r) => ens.has(r.code_parcelle), limite);
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
    formeJuridiqueLibelle: libelleFormeJuridique(r.forme_juridique),
    numeroSiren: r.numero_siren,
    // Présents à partir du millésime 2026 (absents = undefined, jamais inventés).
    numeroMajic: r.numero_majic,
    groupePersonne: r.groupe_personne,
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
  parSiren, parNom, parParcelles, normaliser, agreger, repondre, erreur, ouvrir,
  versFrontend, DEPARTEMENTS, cors, libelleFormeJuridique,
};
