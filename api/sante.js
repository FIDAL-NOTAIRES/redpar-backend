/**
 * REDPAR — CONTRÔLE DE SANTÉ DE L'ENVIRONNEMENT
 * =============================================
 * Répond à une question qu'on ne peut pas se contenter de lire au tableau de
 * bord Vercel : les variables FPMU_* sont-elles réellement en place, et dans
 * QUEL environnement ? Le tableau de bord dit ce qui est déclaré ; cet endpoint
 * dit ce que la fonction a effectivement lu au démarrage, environnement par
 * environnement, puisqu'il suffit de l'ouvrir sur l'URL de Production puis sur
 * celle d'un déploiement Preview.
 *
 * POURQUOI C'EST NÉCESSAIRE. Le repli des trois variables n'est pas symétrique :
 *   FPMU_BASE_URL    sans défaut → l'absence est BRUYANTE, mais seulement à la
 *                    première requête métier (« FPMU_BASE_URL non configurée »).
 *   FPMU_MILLESIME   défaut '2025' → l'absence est SILENCIEUSE. Une Preview
 *                    pourrait interroger un autre millésime que celui voulu sans
 *                    que rien ne le signale. C'est le vrai risque de septembre.
 *   FPMU_MAX_LIGNES  défaut 20000 → l'absence est silencieuse et bénigne, mais
 *                    une valeur non numérique donne Number('...') = NaN, et un
 *                    plafond NaN tronque à zéro ligne sans erreur.
 * Le projet a pour règle qu'aucune troncature ni aucun repli ne soit muet (§ 5
 * n du mémo v5). Cet endpoint applique la même règle à sa configuration.
 *
 * AUCUN SECRET N'EST EXPOSÉ : les trois variables portent une URL de release
 * GitHub PUBLIQUE et deux nombres. Si une variable secrète était ajoutée un
 * jour au projet, ne pas l'afficher ici — se contenter de « définie : oui ».
 *
 * Usage :
 *   /api/sante           contrôle complet, lecture du pied des trois parquet
 *   /api/sante?lecture=0 configuration seule, sans aucun appel réseau
 */

const { cors, MILLESIME, MAX_LIGNES, ouvrir } = require('./_fpmu');

const JEUX = ['parcelles', 'locaux', 'annuaire'];

// Nombre de groupes de lignes attendu, mesuré le 27/07/2026 sur la release
// fpmu-2025. C'est le témoin de l'élagage par statistiques : si le découpage
// changeait, une requête cesserait de ne télécharger qu'un groupe sur 187.
const GROUPES_ATTENDUS = { parcelles: 187, locaux: 225 };

function describeVar(nom, valeurDefaut) {
  const brut = process.env[nom];
  const definie = brut !== undefined && brut !== '';
  return {
    definie,
    source: definie ? 'environnement' : 'défaut du code',
    valeur: definie ? brut : valeurDefaut,
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const t0 = Date.now();
  const avecLecture = (req.query || {}).lecture !== '0';
  const remarques = [];
  let etat = 'ok';
  const degrader = (niveau, texte) => {
    remarques.push(`${niveau === 'panne' ? '⛔' : '⚠'} ${texte}`);
    if (niveau === 'panne' || etat === 'ok') etat = niveau;
  };

  // ---------------------------------------------------------------- variables
  const variables = {
    FPMU_BASE_URL: describeVar('FPMU_BASE_URL', null),
    FPMU_MILLESIME: describeVar('FPMU_MILLESIME', '2025'),
    FPMU_MAX_LIGNES: describeVar('FPMU_MAX_LIGNES', '20000'),
    // Quatrième variable, absente de la liste du mémo : le mémo v5 n'en annonce
    // que trois alors que api/geo.js en lit une quatrième, avec repli.
    CADASTRE_BASE_URL: describeVar('CADASTRE_BASE_URL', '(repli codé dans api/geo.js)'),
  };

  if (!variables.FPMU_BASE_URL.definie) {
    degrader('panne', 'FPMU_BASE_URL absente : toute requête métier échouera '
      + '(« FPMU_BASE_URL non configurée »). À renseigner dans cet environnement.');
  }
  if (!variables.FPMU_MILLESIME.definie) {
    degrader('alerte', `FPMU_MILLESIME absente : lecture SILENCIEUSE du millésime `
      + `${MILLESIME} par défaut. À renseigner explicitement, faute de quoi le `
      + `basculement de septembre 2026 passera inaperçu.`);
  }
  if (!variables.FPMU_MAX_LIGNES.definie) {
    remarques.push(`ℹ FPMU_MAX_LIGNES absente : plafond de ${MAX_LIGNES} lignes par défaut.`);
  }
  if (!Number.isFinite(MAX_LIGNES) || MAX_LIGNES <= 0) {
    degrader('panne', `FPMU_MAX_LIGNES vaut « ${variables.FPMU_MAX_LIGNES.valeur} », `
      + `soit un plafond effectif de ${MAX_LIGNES} : les relevés seraient tronqués `
      + `à vide sans message d'erreur.`);
  }

  // Cohérence entre le millésime demandé et la release visée. C'est le piège de
  // septembre : basculer FPMU_BASE_URL sur fpmu-2026 en oubliant FPMU_MILLESIME
  // ferait chercher parcelles-2025.parquet dans la release 2026, donc un 404 ;
  // l'inverse ferait lire du 2025 en croyant lire du 2026.
  const baseUrl = variables.FPMU_BASE_URL.valeur || '';
  const millesimeDeLaBase = (baseUrl.match(/fpmu-(\d{4})\/?$/) || [])[1] || null;
  if (millesimeDeLaBase && millesimeDeLaBase !== String(MILLESIME)) {
    degrader('panne', `Incohérence : FPMU_BASE_URL pointe la release fpmu-${millesimeDeLaBase} `
      + `alors que FPMU_MILLESIME vaut ${MILLESIME}. Le fichier `
      + `parcelles-${MILLESIME}.parquet n'y existe pas.`);
  }

  // -------------------------------------------------------------- lecture réelle
  // Le seul contrôle qui vaille : ouvrir les trois jeux comme le fait une
  // requête, ce qui exerce la release GitHub, son caractère public, le pied de
  // parquet et l'index des groupes. ~0,5 Mo par fichier.
  const jeux = {};
  if (avecLecture && variables.FPMU_BASE_URL.definie) {
    await Promise.all(JEUX.map(async (jeu) => {
      const t = Date.now();
      try {
        const o = await ouvrir(jeu);
        jeux[jeu] = {
          lisible: true,
          url: o.url,
          lignes: o.total,
          nb_groupes: o.groupes.length,
          ms: Date.now() - t,
        };
        const attendu = GROUPES_ATTENDUS[jeu];
        if (attendu && o.groupes.length !== attendu) {
          degrader('alerte', `${jeu} : ${o.groupes.length} groupes de lignes au lieu `
            + `des ${attendu} mesurés sur fpmu-2025. Découpage ou millésime différent : `
            + `revérifier que l'élagage ne télécharge toujours qu'un seul groupe.`);
        }
      } catch (e) {
        jeux[jeu] = { lisible: false, erreur: e.message, ms: Date.now() - t };
        degrader('panne', `${jeu} illisible : ${e.message}`);
      }
    }));
  }

  // ------------------------------------------------------------------- réponse
  const corps = {
    etat,                                     // ok | alerte | panne
    remarques,
    environnement: {
      // VERCEL_ENV vaut « production », « preview » ou « development ». C'est
      // lui qui répond à la question posée : sur quel environnement suis-je ?
      vercel_env: process.env.VERCEL_ENV || '(hors Vercel)',
      branche: process.env.VERCEL_GIT_COMMIT_REF || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      url: process.env.VERCEL_URL || null,
      region: process.env.VERCEL_REGION || null,
      node: process.version,
    },
    variables,
    valeurs_effectives: {
      // Lues depuis les exports de api/_fpmu.js, donc telles que le module les a
      // réellement calculées au démarrage — et non relues ici, ce qui pourrait
      // masquer un écart.
      millesime: MILLESIME,
      max_lignes: MAX_LIGNES,
    },
    lecture: avecLecture ? jeux : '(ignorée : ?lecture=0)',
    ms: Date.now() - t0,
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); // un contrôle de santé ne se cache pas
  res.status(etat === 'panne' ? 503 : 200).send(JSON.stringify(corps, null, 2));
};
