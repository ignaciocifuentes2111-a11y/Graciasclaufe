// Kino plugin: LAT-ADD. Habla el protocolo de addons de Stremio (catalog, meta, stream)
// contra TU enlace personal (Addon Latam), que se guarda en los ajustes del plugin (nunca en este archivo).
let manifestCache = null;

function base() {
  const raw = String(kino.config.get("addon") || "").trim();
  const m = raw.match(/^(https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~-]+)\/manifest\.json$/) || raw.match(/^(https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~-]+)\/?$/);
  if (!m) throw kino.error("not_found", "Pega en los ajustes tu enlace https://…/manifest.json");
  return m[1];
}

async function get(path) {
  const r = await kino.fetch(base() + path);
  if (!r.ok) throw new Error("El addon respondió " + r.status);
  return r.json();
}

async function manifest() {
  if (!manifestCache) manifestCache = await get("/manifest.json");
  return manifestCache;
}

const hasExtra = (c, name) => (c.extra || []).some((e) => e.name === name);
const required = (c) => (c.extra || []).some((e) => e.isRequired);
const idOf = (s) => String(s).replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 128);
const https = (u) => (typeof u === "string" && u.startsWith("https://") ? u : undefined);
const enc = encodeURIComponent;

function card(m, type) {
  const t = m.type || type;
  const item = { id: idOf(m.id), ref: t + "|" + m.id, title: String(m.name || m.id), kind: t === "movie" ? "movie" : "series" };
  const year = parseInt(String(m.year || m.releaseInfo || "").slice(0, 4), 10);
  if (year) item.year = year;
  if (https(m.poster)) item.poster = m.poster;
  if (https(m.background)) item.backdrop = m.background;
  if (m.description) item.overview = String(m.description).slice(0, 1000);
  if (Array.isArray(m.genres)) item.genres = m.genres.slice(0, 5).map((g) => String(g).slice(0, 30));
  const rating = parseFloat(m.imdbRating);
  if (rating >= 0 && rating <= 10) item.rating = rating;
  if (/^tt\d{5,10}$/.test(m.imdb_id || m.id || "")) item.ids = { imdb: m.imdb_id || m.id };
  return item;
}

async function page(type, catId, extra) {
  const data = await get("/catalog/" + enc(type) + "/" + enc(catId) + (extra ? "/" + extra : "") + ".json");
  return (Array.isArray(data.metas) ? data.metas : []).filter((m) => m && m.id).map((m) => card(m, type));
}

export async function home() {
  const mf = await manifest();
  const rows = [];
  for (const c of (mf.catalogs || []).filter((x) => !required(x)).slice(0, 8)) {
    try {
      const items = await page(c.type, c.id);
      if (items.length) rows.push({ id: idOf(c.type + "_" + c.id), title: String(c.name || c.id), items: items.slice(0, 24), ref: c.type + "|" + c.id });
    } catch (e) {
      kino.log("fila fallida", c.id, e.message);
    }
  }
  return rows;
}

export async function browse(ref, cursor) {
  const [type, catId] = String(ref).split("|");
  const skip = cursor ? parseInt(cursor, 10) || 0 : 0;
  const items = await page(type, catId, skip ? "skip=" + skip : "");
  return { items, next: items.length ? String(skip + items.length) : undefined };
}

export async function search(query) {
  const q = String(query.q || "").trim();
  if (!q) return [];
  const mf = await manifest();
  const cats = (mf.catalogs || []).filter((c) => hasExtra(c, "search"));
  const found = await Promise.all(cats.map((c) => page(c.type, c.id, "search=" + enc(q)).catch(() => [])));
  const seen = new Set();
  return found.flat().filter((i) => !seen.has(i.ref) && seen.add(i.ref)).slice(0, 40);
}

export async function episodes(ref) {
  const [type, id] = String(ref).split("|");
  const data = await get("/meta/" + enc(type) + "/" + enc(id) + ".json");
  const m = data.meta || {};
  const out = (Array.isArray(m.videos) ? m.videos : [])
    .filter((v) => v && v.id)
    .map((v, i) => {
      const e = { season: parseInt(v.season, 10) || 1, number: parseInt(v.episode ?? v.number, 10) || i + 1, ref: "series|" + v.id, title: v.title || v.name };
      if (https(v.thumbnail)) e.still = v.thumbnail;
      if (v.overview || v.description) e.overview = String(v.overview || v.description).slice(0, 600);
      return e;
    });
  return { series: { title: m.name, poster: https(m.poster), backdrop: https(m.background), overview: m.description, genres: m.genres }, episodes: out };
}

export async function resolve(ref) {
  const [type, id] = String(ref).split("|");
  const data = await get("/stream/" + enc(type) + "/" + enc(id) + ".json");
  const list = (Array.isArray(data.streams) ? data.streams : []).filter((s) => s && /^https?:\/\//.test(s.url || ""));
  if (!list.length) throw kino.error("not_found", "No hay fuente disponible para este título");
  const s = list[0];
  const out = { url: s.url };
  const headers = s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request;
  if (headers) out.headers = headers;
  if (/\.m3u8(\?|$)/i.test(s.url)) out.mime = "application/x-mpegURL";
  if (Array.isArray(s.subtitles)) out.subtitles = s.subtitles.filter((x) => x && https(x.url)).map((x) => ({ lang: String(x.lang || "und"), url: x.url }));
  return out;
}
