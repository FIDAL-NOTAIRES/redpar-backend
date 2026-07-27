/**
 * REDPAR — GET /api/geo
 * =====================
 * Géocodage À LA PARCELLE, depuis le cadastre Etalab.
 *
 * Les fichiers DGFiP des personnes morales ne portent aucune coordonnée : ils
 * donnent la référence cadastrale, pas la géométrie. C'était la valeur ajoutée
 * du miroir Koumoul, perdue en passant à la source officielle. On la reconstitue
 * ici en joignant sur le plan cadastral, dont l'identifiant de parcelle a
 * exactement le même format que le nôtre (14 caractères :
 * commune 5 + préfixe 3 + section 2 + numéro 4).
 *
 * Stratégie. Une requête REDPAR ne touche qu'une poignée de communes (47 pour
 * LOGIS METROPOLE, sur 34 947). On récupère donc le plan de ces communes-là, à
 * la demande, plutôt que de traiter la centaine de gigaoctets du plan national
 * à la construction. Même précision, sans l'usine.
 *
 * Paramètres :
 *   ?insee=59009            (obligatoire) code commune sur 5 caractères
 *   &ids=0000LE0030,...     (facultatif) suffixes préfixe+section+numéro sur
 *                           9 caractères, ou références complètes sur 14.
 *                           Sans « ids », toute la commune est renvoyée.
 *   &contours=1             (facultatif) joint la géométrie complète, pour la
 *                           projection de contours (MARTEAU, PAINT).
 *
 * Réponse :
 *   { insee, total, trouves, geo: { "<ref 14>": { lat, lng,
 *       contenance_cadastre, contour? } }, manquants: [...] }
 *
 * ⚠ Le plan cadastral et la matrice DGFiP ne sont pas au même millésime : une
 * parcelle très récemment créée ou remembrée peut manquer. Les absences sont
 * donc renvoyées explicitement dans « manquants » plutôt que silencieusement
 * omises.
 */

const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const BASE_CADASTRE = process.env.CADASTRE_BASE_URL
  || 'https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes';

const MAX_IDS = 400;

// Cache par conteneur : une commune analysée une fois sert toutes les requêtes
// suivantes tant que la fonction reste tiède.
const cache = new Map();
const MAX_COMMUNES_EN_CACHE = 12;

/** Département au sens des chemins du cadastre : 2 caractères, 3 en outre-mer. */
function departementDe(insee) {
  return /^9[78]/.test(insee) ? insee.slice(0, 3) : insee.slice(0, 2);
}

/**
 * Centroïde d'aire d'un anneau polygonal (formule du barycentre de surface).
 * La moyenne des sommets serait plus simple mais tombe hors de la parcelle dès
 * qu'elle est concave ou que ses sommets sont inégalement répartis.
 */
function centroideAnneau(anneau) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = anneau.length - 1; i < n; i++) {
    const [x0, y0] = anneau[i];
    const [x1, y1] = anneau[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (a === 0) {                        // dégénéré : on retombe sur la moyenne
    const n = anneau.length;
    return [anneau.reduce((s, p) => s + p[0], 0) / n,
      anneau.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function aireAnneau(anneau) {
  let a = 0;
  for (let i = 0, n = anneau.length - 1; i < n; i++) {
    a += anneau[i][0] * anneau[i + 1][1] - anneau[i + 1][0] * anneau[i][1];
  }
  return Math.abs(a / 2);
}

/** Centroïde d'une géométrie GeoJSON : anneau extérieur le plus vaste. */
function centroide(geom) {
  if (!geom) return null;
  let anneaux = [];
  if (geom.type === 'Polygon') anneaux = [geom.coordinates[0]];
  else if (geom.type === 'MultiPolygon') anneaux = geom.coordinates.map((p) => p[0]);
  else if (geom.type === 'Point') return [geom.coordinates[0], geom.coordinates[1]];
  else return null;
  anneaux = anneaux.filter((r) => Array.isArray(r) && r.length > 2);
  if (!anneaux.length) return null;
  const plusVaste = anneaux.reduce((m, r) => (aireAnneau(r) > aireAnneau(m) ? r : m));
  return centroideAnneau(plusVaste);
}

/** Télécharge et indexe le plan d'une commune : référence -> centroïde. */
async function planCommune(insee) {
  if (cache.has(insee)) return cache.get(insee);
  const promesse = (async () => {
    const url = `${BASE_CADASTRE}/${departementDe(insee)}/${insee}`
      + `/cadastre-${insee}-parcelles.json.gz`;
    const r = await fetch(url);
    if (r.status === 404) {
      // Commune non couverte par le plan vecteur : cela existe.
      return { index: new Map(), absente: true, url };
    }
    if (!r.ok) throw new Error(`cadastre ${r.status} sur ${insee}`);
    const brut = await gunzip(Buffer.from(await r.arrayBuffer()));
    const fc = JSON.parse(brut.toString('utf8'));
    const index = new Map();
    for (const f of fc.features || []) {
      const p = f.properties || {};
      const ref = p.id || p.idu;
      if (!ref) continue;
      const c = centroide(f.geometry);
      if (!c) continue;
      index.set(ref, {
        lng: Number(c[0].toFixed(6)),
        lat: Number(c[1].toFixed(6)),
        contenance_cadastre: p.contenance !== undefined ? Number(p.contenance) : null,
        contour: f.geometry,
      });
    }
    return { index, absente: false, url };
  })();
  cache.set(insee, promesse);
  if (cache.size > MAX_COMMUNES_EN_CACHE) {
    cache.delete(cache.keys().next().value);   // éviction du plus ancien
  }
  try {
    return await promesse;
  } catch (e) {
    cache.delete(insee);
    throw e;
  }
}

module.exports = async function handler(req, res) {
  // Voir la note de api/_fpmu.js : sans en-têtes CORS, le navigateur bloque.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const json = (code, corps) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Le plan cadastral bouge quelques fois par an : on peut cacher longtemps.
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
    res.status(code).send(JSON.stringify(corps));
  };
  if (req.method !== 'GET') return json(405, { erreur: 'Méthode non autorisée' });

  const { insee, ids, contours } = req.query || {};
  if (!insee || !/^[0-9]{5}$|^2[AB][0-9]{3}$/.test(String(insee))) {
    return json(400, { erreur: 'Paramètre insee requis (code commune sur 5 caractères)' });
  }

  try {
    const { index, absente, url } = await planCommune(String(insee));

    // Références demandées : soit les 14 caractères complets, soit le suffixe
    // de 9 (préfixe + section + numéro), la commune étant déjà connue.
    let refs = null;
    if (ids) {
      refs = String(ids).split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (s.length === 14 ? s : `${insee}${s}`))
        .slice(0, MAX_IDS);
    }

    const geo = {};
    const manquants = [];
    const source = refs || Array.from(index.keys());
    for (const ref of source) {
      const v = index.get(ref);
      if (!v) { manquants.push(ref); continue; }
      geo[ref] = contours
        ? { lat: v.lat, lng: v.lng, contenance_cadastre: v.contenance_cadastre, contour: v.contour }
        : { lat: v.lat, lng: v.lng, contenance_cadastre: v.contenance_cadastre };
    }

    return json(200, {
      insee: String(insee),
      total: source.length,
      trouves: Object.keys(geo).length,
      geo,
      manquants,
      ...(absente ? { commune_absente_du_plan: true } : {}),
      source: 'Plan cadastral informatisé (DGFiP), version Etalab — '
        + 'Licence Ouverte. Le millésime du plan peut différer de celui de la '
        + 'matrice : une parcelle récemment créée ou remembrée peut manquer.',
      ...(process.env.NODE_ENV !== 'production' ? { url } : {}),
    });
  } catch (e) {
    console.error('api/geo', e);
    return json(502, { erreur: `Géocodage indisponible : ${e.message}` });
  }
};
