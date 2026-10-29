const {
  CATEGORIES, CACHE_TTL_MS, cache, hit, getFavoriteIds, getDetails,
} = require("../lib/roblox");

const API_SECRET = process.env.API_SECRET || ""; // opsional
const IP_LIMIT = 120;
const USER_LIMIT = 40;

function fail(res, status, error, message, extra = {}) {
  return res.status(status).json({ ok: false, error, message, ...extra });
}

function buildItems(ids, details) {
  return ids.map((id) => {
    const d = details && details[id];
    if (!d) {
      return { id, name: null, assetType: null, price: null, onSale: false, limited: false };
    }
    const r = d.itemRestrictions || [];
    const limited = r.includes("Limited") || r.includes("LimitedUnique");
    const price = typeof d.price === "number" ? d.price
      : typeof d.lowestPrice === "number" ? d.lowestPrice : null;
    const offSale = d.priceStatus === "Off Sale" || d.isOffSale === true;
    return {
      id,
      name: d.name || null,
      assetType: typeof d.assetType === "number" ? d.assetType : null,
      price,
      onSale: price !== null && !offSale,
      limited,
    };
  });
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
  const cat = Object.prototype.hasOwnProperty.call(CATEGORIES, category)
    ? CATEGORIES[category]
    : null;
  if (!cat) {
    return fail(res, 400, "KATEGORI_TIDAK_DIDUKUNG",
      "Kategori tidak didukung.", { supported: Object.keys(CATEGORIES) });
  }

  // Cache dibagi per tipe fetch, jadi sub-kategori aksesori memakai data yang sama
  const baseKey = `${userId}:${cat.fetch}`;
  let base = null;
  let cached = false;

  if (!raw && refresh !== "1") {
    const c = cache.get(baseKey);
    if (c && Date.now() < c.expires) {
      base = c;
      cached = true;
    }
  }

  try {
    if (!base) {
      if (!hit("user:" + userId, USER_LIMIT)) {
        return fail(res, 429, "TERLALU_BANYAK_REQUEST", "Terlalu sering memuat favorit pemain ini. Tunggu 1 menit.");
      }

      const fav = await getFavoriteIds(userId, cat.fetch);

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
      base = { source: fav.source, ids: fav.ids, details, expires: Date.now() + CACHE_TTL_MS };
      if (details !== null) {
        if (cache.size > 2000) cache.clear();
        cache.set(baseKey, base);
      }
    }

    const details = base.details;

    if (cat.types && base.ids.length && details === null) {
      return fail(res, 502, "DETAIL_ITEM_GAGAL",
        "Detail item dari Roblox gagal dimuat, jadi kategori tidak bisa disaring. Coba lagi.");
    }

    let ids = base.ids;
    if (cat.types && details) {
      ids = base.ids.filter((id) => {
        const d = details[id];
        if (!d || typeof d.assetType !== "number") return true;
        return cat.types.includes(d.assetType);
      });
    }

    const items = buildItems(ids, details);

    return res.status(200).json({
      ok: true,
      userId: Number(userId),
      category,
      count: items.length,
      source: base.source,
      detailsAvailable: details !== null,
      items,
      note: items.length === 0
        ? "Tidak ada favorit di kategori ini, atau favorit pemain bersifat privat."
        : details === null
        ? "Detail item (nama/harga) gagal dimuat dari Roblox."
        : "",
      cached,
    });
  } catch (e) {
    return fail(res, 504, "ROBLOX_TIDAK_MERESPONS", "Server Roblox tidak merespons. Coba lagi.");
  }
};
// END favorites.js
