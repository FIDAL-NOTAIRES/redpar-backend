// Backend proxy REDPAR — Recherche de parcelles
// Interroge l'API Koumoul (dataset MAJIC - Parcelles des personnes morales)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { siren, nom } = req.query;

  if (!siren && !nom) {
    return res.status(400).json({
      error: 'Paramètre manquant : fournir siren ou nom',
    });
  }

  try {
    // L'API publique de Koumoul utilise cette URL
    const baseUrl = 'https://opendata.koumoul.com/data-fair/api/v1/datasets/parcelles-des-personnes-morales/lines';

    const params = new URLSearchParams({ size: '100' });
    if (siren) {
      params.set('numero_siren_eq', siren);
    } else {
      params.set('q', nom);
    }

    const apiUrl = `${baseUrl}?${params}`;

    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return res.status(response.status).json({
        error: `Erreur API Koumoul : ${response.status}`,
        url: apiUrl,
        details: text.substring(0, 500),
      });
    }

    const data = await response.json();
    const rows = data.results || [];

    const parcelles = rows.map((r) => ({
      codeParcelle: r.code_parcelle,
      commune: r.nom_commune || r['_infos_commune.nom_commune'],
      departement: r['_infos_commune.nom_departement'] || r.departement,
      adresse: r.adresse,
      contenance: r.contenance_parcelle,
      natureCulture: r.nature_culture,
      denomination: r.denomination,
      siren: r.numero_siren,
      formeJuridique: r.forme_juridique_abregee,
      coordonnees: r._geopoint || r['_parcelle_coords.coord'],
      epci: r['_infos_commune.nom_epci'],
      region: r['_infos_commune.nom_region'],
    }));

    return res.status(200).json({
      siren: siren || null,
      nom: nom || null,
      count: parcelles.length,
      total: data.total || parcelles.length,
      parcelles,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Erreur serveur',
      details: error.message,
    });
  }
}
