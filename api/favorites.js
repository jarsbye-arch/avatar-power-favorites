/ Peta kategori -> AssetTypeId Roblox
const CATEGORIES = {
  hat: 8,
  hair: 41,
  face_accessory: 42,
  neck: 43,
  shoulder: 44,
  front: 45,
  back: 46,
  waist: 47,
  shirt: 11,
  pants: 12,
  tshirt: 2,
  face: 18,
  gear: 19,
  emote: 61,
};

const API_SECRET = process.env.API_SECRET || ""; // opsional
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 120 * 1000;
const WINDOW_MS = 60 * 1000;
const IP_LIMIT = 30;
const USER_LIMIT = 8;

const cache = new Map();
const hits = new Map();

function hit(key, limit) {
  const now = Date.now();
  let e = hits.get(key);
  if (!e || now > e.reset) {
    e = { count: 0, reset: now + WINDOW_MS };
    hits.set(key, e);
  }
  e.count++;
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }
  return e.count <= limit;
}

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    let json = null;
    try {
      json = await r.json();
    } catch (e) {}
    return { status: r.status, json, headers: r.headers };
  } finally {
    clearTimeout(timer);
  }
}

// Menarik ID aset dari berbagai bentuk respons yang mungkin
function extractIds(json) {
  if (!json) return [];
  const list = Array.isArray(json)
    ? json
    : json.data || (json.Data && json.Data.Items) || json.FavoriteAssets ||
      json.favorites || json.Items || json.items || [];
  const ids = [];
  for (const el of Array.isArray(list) ? list : []) {
    let id = el;
    if (el && typeof el === "object") {
      id = el.id ?? el.assetId ?? el.AssetId ??
        (el.Item && el.Item.AssetId) ?? (el.item && el.item.assetId);
    }
    if (Number.isInteger(id)) ids.push(id);
  }
  return [...new Set(ids)];
}

async function getFavoriteIds(userId, typeId) {
  const attempts = [
    ["catalog", `https://catalog.roblox.com/v1/favorites/users/${userId}/favorites/${typeId}/assets?limit=100`],
    ["legacy", `https://www.roblox.com/users/favorites/list-json?assetTypeId=${typeId}&itemsPerPage=100&userId=${userId}`],
  ];
  let last = null;
  let empty = null;
  for (const [source, url] of attempts) {
    const r = await fetchJson(url);
    last = { source, status: r.status, json: r.json };
    if (r.status === 429) break;
    if (r.status === 200 && r.json) {
      const ids = extractIds(r.json);
      if (ids.length > 0) return { ok: true, source, ids, json: r.json };
      empty = { ok: true, source, ids: [], json: r.json };
    }
  }
  if (empty) return empty;
  return { ok: false, ...last };
}

async function getDetails(ids) {
  const out = {};
  const url = "https://catalog.roblox.com/v1/catalog/items/details";
  for (let i = 0; i < ids.length; i += 100) {
    const body = JSON.stringify({
      items: ids.slice(i, i + 100).map((id) => ({ itemType: "Asset", id })),
    });
    const h = { "Content-Type": "application/json" };
    let r = await fetchJson(url, { method: "POST", headers: h, body });
    const csrf = r.headers.get("x-csrf-token");
    if (r.status === 403 && csrf) {
      r = await fetchJson(url, {
        method: "POST",
        headers: { ...h, "x-csrf-token": csrf },
        body,
      });
    }
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.data)) return null;
    for (const d of r.json.data) out[d.id] = d;
  }
  return out;
}

function fail(res, status, error, message, extra = {}) {
  return res.status(status).json({ ok: false, error, message, ...extra });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    return fail(res, 405, "METHOD_TIDAK_DIDUKUNG", "Gunakan GET.");
  }

  if (API_SECRET) {
    const given = req.headers["x-api-secret"] || (req.query && req.query.secret);
    if (given !== API_SECRET) {
      return fail(res, 401, "TIDAK_DIIZINKAN", "Secret tidak valid.");
    }
  }

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (!hit("ip:" + ip, IP_LIMIT)) {
    return fail(res, 429, "TERLALU_BANYAK_REQUEST", "Terlalu banyak request. Coba lagi sebentar.");
  }

  const { userId, category, refresh, raw } = req.query || {};

  if (!/^\d{1,12}$/.test(String(userId || "")) || Number(userId) <= 0) {
    return fail(res, 400, "USER_ID_TIDAK_VALID", "userId harus angka positif.");
  }
  const typeId = CATEGORIES[category];
  if (!typeId) {
    return fail(res, 400, "KATEGORI_TIDAK_DIDUKUNG",
      "Kategori tidak didukung.", { supported: Object.keys(CATEGORIES) });
  }

  const cacheKey = `${userId}:${category}`;
  if (!raw && refresh !== "1") {
    const c = cache.get(cacheKey);
    if (c && Date.now() < c.expires) return res.status(200).json({ ...c.data, cached: true });
  }

  if (!hit("user:" + userId, USER_LIMIT)) {
    return fail(res, 429, "TERLALU_BANYAK_REQUEST", "Terlalu sering memuat favorit pemain ini. Tunggu 1 menit.");
  }

  try {
    const fav = await getFavoriteIds(userId, typeId);

    if (raw === "1") {
      return res.status(200).json({ source: fav.source, status: fav.status, ids: fav.ids, json: fav.json });
    }

    if (!fav.ok) {
      if (fav.status === 429) {
        return fail(res, 429, "ROBLOX_RATE_LIMIT", "Roblox membatasi request. Coba lagi nanti.");
      }
      return fail(res, 502, "FAVORIT_TIDAK_TERSEDIA",
        `Roblox tidak mengizinkan/menyediakan favorit kategori ini (status ${fav.status}). ` +
        "Favorit bisa privat atau endpoint berubah.", { upstreamStatus: fav.status });
    }

    const details = fav.ids.length ? await getDetails(fav.ids) : {};
    const items = fav.ids.map((id) => {
      const d = details && details[id];
      if (!d) return { id, name: null, price: null, onSale: false, limited: false };
      const restrictions = d.itemRestrictions || [];
      const limited = restrictions.includes("Limited") || restrictions.includes("LimitedUnique");
      const price = typeof d.price === "number" ? d.price
        : typeof d.lowestPrice === "number" ? d.lowestPrice : null;
      const offSale = d.priceStatus === "Off Sale" || d.isOffSale === true;
      return {
        id,
        name: d.name || null,
        price,
        onSale: price !== null && !offSale,
        limited,
      };
    });

    const data = {
      ok: true,
      userId: Number(userId),
      category,
      count: items.length,
      source: fav.source,
      detailsAvailable: details !== null,
      items,
      note: items.length === 0
        ? "Tidak ada favorit di kategori ini, atau favorit pemain bersifat privat."
        : details === null
        ? "Detail item (nama/harga) gagal dimuat dari Roblox."
        : "",
    };

    if (cache.size > 2000) cache.clear();
    cache.set(cacheKey, { data, expires: Date.now() + CACHE_TTL_MS });
    return res.status(200).json({ ...data, cached: false });
  } catch (e) {
    return fail(res, 504, "ROBLOX_TIDAK_MERESPONS", "Server Roblox tidak merespons. Coba lagi.");
  }
};
