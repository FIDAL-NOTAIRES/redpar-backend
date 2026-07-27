/**
 * REDPAR — GET /api/parcelles
 * ===========================
 * Relevé des parcelles (non bâti) d'une personne morale.
 *
 * Paramètres : ?siren=886980440   ou   ?nom=LOGIS+METROPOLE
 *              &limite=5000 (ou maxResults, graphie de l'ancien frontend)
 * Le SIREN est prioritaire ; à défaut le nom est résolu via l'annuaire.
 *
 * CONTRAT DE SORTIE — imposé par MARTEAU (⚙ Sources › API personnalisée),
 * à ne pas modifier :
 *   { total, results: [ { code_parcelle, nom_commune, adresse,
 *                         contenance_parcelle, code_droit, denomination } ] }
 * Champs supplémentaires (ignorés par MARTEAU, utiles à REDPAR) : numero_siren,
 * forme_juridique, code_insee, code_departement, nature_culture, millesime.
 */

const F = require('./_fpmu');

module.exports = async function handler(req, res) {
  F.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return F.erreur(res, 405, 'Méthode non autorisée');

  const { siren, nom, limite, maxResults } = req.query || {};
  if (!siren && !nom) {
    return F.erreur(res, 400, 'Paramètre siren ou nom requis');
  }

  try {
    let cible = siren && String(siren).trim();
    let resolution = null;

    if (!cible) {
      const { lignes } = await F.parNom(nom, 20);
      if (!lignes.length) {
        return F.repondre(res, 200, {
          total: 0, results: [], millesime: F.MILLESIME,
          resolution: { nom_recherche: nom, trouve: false },
          avertissement: F.AVERTISSEMENT,
        });
      }
      // Plusieurs homonymes possibles : on retient celui qui détient le plus
      // de parcelles, et on expose les autres pour permettre l'arbitrage.
      lignes.sort((a, b) => Number(b.nb_parcelles || 0) - Number(a.nb_parcelles || 0));
      cible = lignes[0].numero_siren;
      resolution = {
        nom_recherche: nom, trouve: true, siren_retenu: cible,
        candidats: lignes.slice(0, 10).map((r) => ({
          numero_siren: r.numero_siren, denomination: r.denomination,
          nb_parcelles: Number(r.nb_parcelles || 0),
          nb_locaux: Number(r.nb_locaux || 0),
        })),
      };
    }

    const { lignes, correspondances, tronque, groupesLus, groupesTotal } =
      await F.parSiren('parcelles', cible, Number(limite || maxResults) || undefined);

    return F.repondre(res, 200, {
      // « total » = nombre réel de correspondances ; « retournes » = ce que
      // cette réponse contient effectivement. Les deux diffèrent au-delà du
      // plafond, et l'écart doit être visible.
      total: correspondances,
      retournes: lignes.length,
      results: lignes.map((r) => ({
        code_parcelle: r.code_parcelle,
        nom_commune: r.nom_commune,
        adresse: r.adresse,
        contenance_parcelle: r.contenance,
        contenance: r.contenance,        // graphie attendue par l'ancien frontend
        code_droit: r.code_droit,
        denomination: r.denomination,
        numero_siren: r.numero_siren,
        forme_juridique: r.forme_juridique,
        code_insee: r.code_insee,
        code_departement: r.code_departement,
        nature_culture: r.nature_culture,
        millesime: F.MILLESIME,
      })),
      // Forme historique attendue par le frontend REDPAR (App.jsx), servie en
      // parallèle du contrat MARTEAU : les deux consommateurs coexistent.
      parcelles: lignes.map(F.versFrontend),
      truncated: !!tronque,
      agregats: F.agreger(lignes, true),
      millesime: F.MILLESIME,
      ...(resolution ? { resolution } : {}),
      ...(tronque ? {
        tronque: true, plafond: F.MAX_LIGNES,
        avertissement_troncature: `Relevé tronqué : ${correspondances.toLocaleString('fr-FR')} `
          + `enregistrements correspondent, ${lignes.length.toLocaleString('fr-FR')} sont renvoyés `
          + `(plafond FPMU_MAX_LIGNES). Les agrégats ci-dessous ne portent que sur les `
          + `enregistrements renvoyés.`,
      } : {}),
      lecture: { groupes_lus: groupesLus, groupes_total: groupesTotal },
      avertissement: F.AVERTISSEMENT,
    });
  } catch (e) {
    console.error('api/parcelles', e);
    return F.erreur(res, 502, `Lecture de la base FPMU impossible : ${e.message}`);
  }
};
