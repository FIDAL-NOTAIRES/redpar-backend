// Backend proxy REDPAR
// Interroge l'API publique Recherche d'Entreprises (data.gouv.fr)

export default async function handler(req, res) {
  // Autoriser les appels depuis n'importe quel domaine (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Gestion de la requête OPTIONS (preflight CORS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Récupération du paramètre de recherche
  const { q } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({
      error: 'Paramètre de recherche manquant ou trop court (min 2 caractères)',
    });
  }

  try {
    // Appel à l'API officielle Recherche d'Entreprises
    const apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&page=1&per_page=10`;
    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Erreur API gouv.fr : ${response.status}`,
      });
    }

    const data = await response.json();

    // Formatage des résultats pour REDPAR
    const results = (data.results || []).map((r) => {
      const dirigeants =
        r.dirigeants?.slice(0, 3).map((d) =>
          `${d.prenoms || ''} ${d.nom || ''} (${d.qualite || 'Dirigeant'})`.trim()
        ) || ['Non communiqué'];

      return {
        siren: r.siren,
        nom: r.nom_complet || r.nom_raison_sociale || q,
        formeJuridique: r.nature_juridique?.libelle || 'N/C',
        adresse: r.siege?.adresse || 'Adresse non communiquée',
        codeApe: `${r.activite_principale || ''} - ${r.libelle_activite_principale || ''}`,
        capitalSocial: r.tranche_effectif_salarie || 'N/C',
        dateCreation: r.date_creation || 'N/C',
        dirigeants,
        statut: r.etat_administratif === 'A' ? 'Active' : 'Cessée',
        source: 'API Recherche Entreprises (gouv.fr)',
      };
    });

    return res.status(200).json({
      query: q,
      count: results.length,
      results,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Erreur serveur',
      details: error.message,
    });
  }
}
