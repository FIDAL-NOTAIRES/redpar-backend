/**
 * REDPAR — GET /api/locaux
 * ========================
 * Relevé des locaux (bâti) d'une personne morale. Volet inexistant avant le
 * passage aux fichiers DGFiP 2025.
 *
 * Paramètres : ?siren=886980440   ou   ?nom=LOGIS+METROPOLE
 *              &limite=5000 (ou maxResults, graphie de l'ancien frontend)
 *
 * Deux particularités de la source, à ne pas prendre pour des anomalies :
 *  - le fichier DGFiP des locaux ne comporte AUCUN numéro invariant : un lot
 *    s'identifie par bâtiment / entrée / niveau / porte sur sa parcelle ;
 *  - il ne comporte AUCUNE surface : pas de contenance sur le bâti.
 * Un même propriétaire peut apparaître deux fois sur un même lot à des titres
 * différents (propriétaire ET gérant, par exemple) : ce ne sont pas des
 * doublons, le code droit les distingue.
 */

const F = require('./_fpmu');

module.exports = async function handler(req, res) {
  F.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return F.erreur(res, 405, 'Méthode non autorisée');

  const { siren, nom, limite, maxResults } = req.query || {};
  if (!siren && !nom) return F.erreur(res, 400, 'Paramètre siren ou nom requis');

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
      lignes.sort((a, b) => Number(b.nb_locaux || 0) - Number(a.nb_locaux || 0));
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
      await F.parSiren('locaux', cible, Number(limite || maxResults) || undefined);
    const base = F.agreger(lignes, false);

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
        batiment: r.batiment,
        entree: r.entree,
        niveau: r.niveau,
        porte: r.porte,
        code_droit: r.code_droit,
        denomination: r.denomination,
        numero_siren: r.numero_siren,
        forme_juridique: r.forme_juridique,
        code_insee: r.code_insee,
        code_departement: r.code_departement,
        millesime: F.MILLESIME,
      })),
      locaux: lignes.map(F.versFrontend),
      truncated: !!tronque,
      agregats: { ...base, nb_lots: lignes.length,
                  nb_immeubles: base.nb_biens_distincts },
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
    console.error('api/locaux', e);
    return F.erreur(res, 502, `Lecture de la base FPMU impossible : ${e.message}`);
  }
};
