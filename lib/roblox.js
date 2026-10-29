const CATEGORIES = {
  accessory:      { fetch: 8,  types: null },
  hat:            { fetch: 8,  types: [8] },
  hair:           { fetch: 41, types: [41] },
  face_accessory: { fetch: 42, types: [42] },
  neck:           { fetch: 43, types: [43] },
  shoulder:       { fetch: 44, types: [44] },
  front:          { fetch: 45, types: [45] },
  back:           { fetch: 46, types: [46] },
  waist:          { fetch: 47, types: [47] },
  shirt:          { fetch: 11, types: [11] },
  pants:          { fetch: 12, types: [12] },
  tshirt:         { fetch: 2,  types: [2] },
  face:           { fetch: 18, types: [18] },
  gear:           { fetch: 19, types: [19] },
  emote:          { fetch: 61, types: [61] },
};

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 120 * 1000;
const WINDOW_MS = 60 * 1000;

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

module.exports = { CATEGORIES, CACHE_TTL_MS, cache, hit, getFavoriteIds, getDetails };
// END lib/roblox.js
