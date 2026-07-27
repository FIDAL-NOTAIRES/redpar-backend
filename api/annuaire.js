/**
 * REDPAR — GET /api/annuaire
 * ==========================
 * Une personne morale figure-t-elle dans la base, et avec quelle volumétrie ?
 * Sert à afficher, dès l'étape 2 de l'assistant, « 1 636 parcelles et 15 451
 * locaux connus » avant de lancer le relevé complet.
 *
 * Paramètres : ?nom=LOGIS   (recherche par DÉBUT de dénomination)
 *              &limite=50
 *
 * ⚠ LIMITE ASSUMÉE : la recherche porte sur le début de la dénomination
 * normalisée, seule forme que le tri du fichier permet d'élaguer sans le
 * parcourir entièrement. « LOGIS » trouve LOGIS METROPOLE, « METROPOLE » ne le
 * trouve pas. Le chemin normal d'identification d'une société dans REDPAR
 * reste l'API Recherche d'Entreprises, qui fournit le SIREN.
 */

const F = require('./_fpmu');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return F.erreur(res, 405, 'Méthode non autorisée');

  const { nom, limite } = req.query || {};
  if (!nom) return F.erreur(res, 400, 'Paramètre nom requis');

  try {
    const { lignes, groupesLus, groupesTotal } =
      await F.parNom(nom, Number(limite) || 50);
    lignes.sort((a, b) =>
      (Number(b.nb_parcelles || 0) + Number(b.nb_locaux || 0))
      - (Number(a.nb_parcelles || 0) + Number(a.nb_locaux || 0)));

    return F.repondre(res, 200, {
      total: lignes.length,
      recherche: { nom, normalise: F.normaliser(nom), mode: 'début de dénomination' },
      results: lignes.map((r) => ({
        numero_siren: r.numero_siren,
        denomination: r.denomination,
        forme_juridique: r.forme_juridique,
        nb_parcelles: Number(r.nb_parcelles || 0),
        nb_locaux: Number(r.nb_locaux || 0),
        contenance_m2: Number(r.contenance_m2 || 0),
      })),
      millesime: F.MILLESIME,
      lecture: { groupes_lus: groupesLus, groupes_total: groupesTotal },
      avertissement: F.AVERTISSEMENT,
    });
  } catch (e) {
    console.error('api/annuaire', e);
    return F.erreur(res, 502, `Lecture de la base FPMU impossible : ${e.message}`);
  }
};
