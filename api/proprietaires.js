/**
 * REDPAR — GET /api/proprietaires
 * ================================
 * Recherche INVERSE : les titulaires de droits de parcelles données.
 * Ajouté le 03/09/2026 (addendum REDPAR v11, § 5 d — chantier copropriété).
 *
 * Les deux jeux historiques sont triés par SIREN et répondent à « que détient
 * cette société ? ». Celui-ci lit proprietaires-<an>.parquet, trié par
 * code_parcelle, et répond à « qui détient cette parcelle ? ». Cas d'usage :
 * une société ne détenant que des lots de copropriété — le fichier des locaux
 * donne la parcelle d'ASSIETTE, cette route en donne le titulaire du sol, qui
 * est le SYNDICAT DES COPROPRIÉTAIRES (groupe de personne 7) quand il est
 * recensé ; son SIREN permet ensuite, par /api/parcelles, de reconstituer
 * l'assiette entière (toutes ses parcelles), puis l'unité foncière.
 *
 * Paramètres :
 *   ?ids=59183000AW0080,59183000AW0081,…   références à 14 caractères, 400 max
 *
 * Réponse :
 *   { total, results: [ { code_parcelle, nom_commune, adresse, contenance,
 *       titulaires: [ { numero_siren, numero_majic, groupe_personne,
 *                       groupe_libelle, code_droit, denomination,
 *                       forme_juridique, syndicat: bool } ] } ],
 *     manquants: [ codes sans aucune personne morale au fichier ],
 *     lecture, millesime, avertissement }
 *
 * ⚠ « manquants » n'est PAS « parcelle sans propriétaire » : c'est « aucune
 * PERSONNE MORALE titulaire au fichier ». Une copropriété dont le sol est aux
 * comptes de copropriétaires personnes physiques y figure — et c'est le cas
 * de la plupart des copropriétés (dix syndicats recensés à Dunkerque).
 *
 * ⚠ vercel.json : cette fonction DOIT y être déclarée, sinon 404.
 */

const F = require('./_fpmu');

const MAX_IDS = 400;

// Groupes de personne MAJIC (colonne « Groupe personne » des fichiers DGFiP).
const GROUPES = {
  '0': 'Personne morale non remarquable',
  '1': 'État',
  '2': 'Région',
  '3': 'Département',
  '4': 'Commune',
  '5': 'Office HLM',
  '6': 'Société d\'économie mixte',
  '7': 'Copropriétaires',
  '8': 'Associés',
  '9': 'Établissement public ou organisme assimilé',
};

// ⚠ LES CODES DGFiP SONT DES LIBELLÉS — constaté sur la release 2025 le
// 03/09/2026 au soir : groupe_personne vaut « 7 - Copropriétaires », code_droit
// vaut « P - Propriétaire ». Le test d'égalité « === '7' » ne trouvait RIEN
// (manifeste : 0 syndicat). On lit le code de tête.
const codeGroupe = (g) => (String(g || '').match(/^\s*(\d)/) || [])[1] || '';

/**
 * Un titulaire est tenu pour SYNDICAT DE COPROPRIÉTAIRES si son groupe est 7,
 * ou si sa dénomination le dit — cas réel à Dunkerque : « SYNDICAT DES
 * COPROPRIETAIRES LA BATELLERIE » est en groupe 0 avec un SIREN fictif MAJIC
 * (U21440362). Le repli est DIT dans la réponse (« syndicat_par »), jamais tu.
 * ⚠ PAS de règle sur le droit S : « S - Syndic de copropriété » désigne le
 * SYNDIC (le gestionnaire, IMMO D'HEM sur AL 69 à Dunkerque), pas le syndicat.
 * Le prendre pour le syndicat reconstituerait « l'assiette » à partir du
 * portefeuille du gestionnaire — toutes les copropriétés qu'il gère.
 */
function qualifierSyndicat(r) {
  if (codeGroupe(r.groupe_personne) === '7') return 'groupe';
  if (/\bSYND(IC(AT)?)?\b.*COPRO|COPROPRI[EÉ]T/i.test(String(r.denomination || ''))) return 'denomination';
  return null;
}

module.exports = async function handler(req, res) {
  F.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return F.erreur(res, 405, 'Méthode non autorisée');

  const brut = String((req.query || {}).ids || '');
  const ids = [...new Set(brut.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length) return F.erreur(res, 400, 'Paramètre ids requis (références à 14 caractères, séparées par des virgules)');
  const invalides = ids.filter((c) => c.length !== 14);
  if (invalides.length) {
    return F.erreur(res, 400, `Références invalides (14 caractères attendus) : ${invalides.slice(0, 5).join(', ')}`);
  }
  if (ids.length > MAX_IDS) return F.erreur(res, 400, `Au plus ${MAX_IDS} références par appel`);

  try {
    const { lignes, correspondances, tronque, groupesLus, groupesTotal } =
      await F.parParcelles(ids);

    const parParcelle = new Map();
    for (const r of lignes) {
      let e = parParcelle.get(r.code_parcelle);
      if (!e) {
        e = {
          code_parcelle: r.code_parcelle,
          code_insee: r.code_insee,
          code_departement: r.code_departement,
          nom_commune: r.nom_commune,
          adresse: r.adresse,
          contenance: r.contenance,
          titulaires: [],
        };
        parParcelle.set(r.code_parcelle, e);
      }
      const par = qualifierSyndicat(r);
      e.titulaires.push({
        numero_siren: r.numero_siren,
        numero_majic: r.numero_majic,
        groupe_personne: r.groupe_personne,
        groupe_code: codeGroupe(r.groupe_personne) || null,
        groupe_libelle: GROUPES[codeGroupe(r.groupe_personne)] || null,
        code_droit: r.code_droit,
        denomination: r.denomination,
        forme_juridique: r.forme_juridique,
        forme_juridique_libelle: F.libelleFormeJuridique(r.forme_juridique),
        syndicat: !!par,
        ...(par ? { syndicat_par: par } : {}),
        // Un SIREN « réel » a neuf chiffres. Les comptes sans SIREN portent un
        // identifiant FICTIF MAJIC (U21440362) — qui est STABLE et TRIÉ comme
        // les autres : /api/parcelles?siren=U21440362 fonctionne (SIREN texte,
        // § 5 f du mémo). La recherche du portefeuille du syndicat n'a donc pas
        // besoin d'un vrai SIREN, seulement d'un identifiant non vide.
        siren_reel: /^\d{9}$/.test(String(r.numero_siren || '')),
        siren_recherchable: !!String(r.numero_siren || '').trim(),
      });
    }
    const results = ids.filter((c) => parParcelle.has(c)).map((c) => parParcelle.get(c));
    const manquants = ids.filter((c) => !parParcelle.has(c));

    return F.repondre(res, 200, {
      total: correspondances,
      retournes: lignes.length,
      results,
      manquants,
      truncated: !!tronque,
      ...(tronque ? { tronque: true, plafond: F.MAX_LIGNES } : {}),
      lecture: { groupes_lus: groupesLus, groupes_total: groupesTotal },
      millesime: F.MILLESIME,
      note: 'Recherche inverse parcelle → titulaires de droits (personnes morales seulement). '
        + '« manquants » = aucune personne morale titulaire au fichier, ce qui est le cas '
        + 'd\'une copropriété dont le sol est aux comptes de copropriétaires personnes physiques.',
      avertissement: F.AVERTISSEMENT,
    });
  } catch (e) {
    console.error('api/proprietaires', e);
    // Release sans index inverse (millésime 2025 : proprietaires-2025.parquet
    // n'existe pas) : on le DIT en clair plutôt qu'un 502 opaque, pour que le
    // frontend affiche « recherche inverse indisponible » et non « erreur ».
    if (/404/.test(String(e && e.message))) {
      F.cors(res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(503).send(JSON.stringify({
        indisponible: true,
        erreur: `Index inverse absent de la release FPMU ${F.MILLESIME} `
          + '(proprietaires-<an>.parquet est construit à partir du millésime 2026). '
          + 'Relancer le workflow fpmu-data, puis mettre FPMU_MILLESIME à jour.',
        millesime: F.MILLESIME,
      }));
    }
    return F.erreur(res, 502, `Lecture de la base FPMU impossible : ${e.message}`);
  }
};
