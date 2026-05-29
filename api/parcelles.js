// Backend proxy REDPAR — Recherche de parcelles
// Interroge l'API Koumoul (dataset MAJIC - Parcelles des personnes morales)
// Récupère TOUTES les parcelles avec pagination automatique

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { siren, nom, maxResults = '5000' } = req.query;

  if (!siren && !nom) {
    return res.status(400).json({
      error: 'Paramètre manquant : fournir siren ou nom',
    });
  }

  const maxToFetch = Math.min(parseInt(maxResults, 10) || 5000, 10000);

  try {
    const baseUrl = 'https://opendata.koumoul.com/data-fair/api/v1/datasets/parcelles-des-personnes-morales/lines';

    const buildParams = (pageSize = 1000) => {
      const p = new URLSearchParams({ size: String(pageSize) });
      if (siren) p.set('numero_siren_eq', siren);
      else p.set('q', nom);
      return p;
    };

    // Première requête : récupère 1000 parcelles + le total
    const firstParams = buildParams(1000);
    const firstResp = await fetch(`${baseUrl}?${firstParams}`, {
      headers: { Accept: 'application/json' },
    });

    if (!firstResp.ok) {
      const text = await firstResp.text().catch(() => '');
      return res.status(firstResp.status).json({
        error: `Erreur API Koumoul : ${firstResp.status}`,
        details: text.substring(0, 500),
      });
    }

    const firstData = await firstResp.json();
    const total = firstData.total || 0;
    let allRows = firstData.results || [];

    // Pagination : récupère les pages suivantes si besoin
    const targetCount = Math.min(total, maxToFetch);
    let nextUrl = firstData.next || null;

    while (allRows.length < targetCount && nextUrl) {
      const nextResp = await fetch(nextUrl, {
        headers: { Accept: 'application/json' },
      });
      if (!nextResp.ok) break;
      const nextData = await nextResp.json();
      const nextRows = nextData.results || [];
      if (nextRows.length === 0) break;
      allRows = allRows.concat(nextRows);
      nextUrl = nextData.next || null;
    }

    // Tronquer au maximum demandé
    allRows = allRows.slice(0, maxToFetch);

    // Formatage pour REDPAR
    const parcelles = allRows.map((r) => ({
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
      total,
      truncated: parcelles.length < total,
      parcelles,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Erreur serveur',
      details: error.message,
    });
  }
}
