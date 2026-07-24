// V2 standalone server — GPT-cleaned Bangumi catalog
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || process.argv.find(a => a.startsWith("--port="))?.slice(7) || "3002");

// ─── Load & normalize catalog ───
const rawCatalog = JSON.parse(readFileSync(resolve(__dirname, "data", "catalog", "expanded-anime.json"), "utf8"));

// Normalize GPT field names → frontend-compatible flat format
const catalog = rawCatalog.map(a => ({
  id: String(a.id),
  title: a.name_cn || a.name || "",
  titleOriginal: (a.name_cn && a.name !== a.name_cn) ? a.name : "",
  cover: a.image || "",
  year: a.date ? parseInt(a.date.slice(0, 4)) : 0,
  airDate: a.date || "",
  score: a.rating?.score || 0,
  ratingCount: a.rating?.total || 0,
  members: a.collection?.collect || 0,
  collection: a.collection || {},
  type: a.platform || "",
  episodes: a.eps || 0,
  description: a.description || "",
  categories: a.meta_tags || [],
  tags: a.tags || [],
  seriesKey: a.seriesKey || "",
  seriesRole: a.seriesRole || "main",
  seriesTitle: a.seriesTitle || "",
  seriesRootId: a.seriesRootId || a.id,
}));

console.log(`Catalog: ${catalog.length} items`);

// ─── Load BPR model ───
const modelData = JSON.parse(readFileSync(resolve(__dirname, "data", "models", "bpr-items.json"), "utf8"));
const factors = modelData.item_factors;
const nItems = modelData.n_items;

const idToIndex = new Map();
modelData.ids.forEach((id, i) => idToIndex.set(String(id), i));
const catMap = new Map(catalog.map(a => [a.id, a]));

console.log(`Model: ${nItems} items x ${factors[0].length}D port=${PORT}`);

// ─── Math utils ───
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s); }
function cosine(a, b) { const d = dot(a, b); return d / (norm(a) * norm(b) + 1e-8); }
function centroid(items, weights) {
  const dim = items[0].length;
  const c = new Array(dim).fill(0);
  let tw = 0;
  for (let i = 0; i < items.length; i++) {
    for (let d = 0; d < dim; d++) c[d] += items[i][d] * weights[i];
    tw += weights[i];
  }
  if (tw > 0) for (let d = 0; d < dim; d++) c[d] /= tw;
  return c;
}

// ─── Seed cards ───
function getSeedCards(count) {
  const seedNames = [
    "命运石之门", "魔法少女小圆", "CLANNAD", "星际牛仔",
    "新世纪福音战士", "Code Geass 反叛的鲁路修", "龙与虎", "冰菓",
    "Angel Beats!", "Fate/Zero", "刀剑神域", "Re：从零开始的异世界生活",
    "鬼灭之刃", "咒术回战", "孤独摇滚！", "间谍过家家",
    "进击的巨人", "千与千寻", "哈尔的移动城堡", "你的名字。",
    "名侦探柯南", "航海王", "龙猫", "幽灵公主", "天空之城",
    "银魂", "夏目友人帐", "死亡笔记",
  ];

  const usedSeries = new Set();
  const exact = [];

  for (const name of seedNames) {
    const matches = catalog.filter(a => a.title === name);
    if (!matches.length) continue;
    let best = null;
    for (const m of matches) {
      if (usedSeries.has(m.seriesKey)) continue;
      if (!best || m.members > (best.members || 0)) best = m;
    }
    if (best) { usedSeries.add(best.seriesKey); exact.push(best); }
  }

  const top = [...catalog]
    .filter(a => a.members > 10000 && a.score >= 7.0 && a.year >= 1995 && a.year <= 2025)
    .sort((a, b) => b.members - a.members);

  const result = [...exact];
  for (const a of top) {
    if (result.length >= count) break;
    if (usedSeries.has(a.seriesKey)) continue;
    usedSeries.add(a.seriesKey);
    result.push(a);
  }
  return result.slice(0, count);
}

// ─── Recommend ───
function recommend(events, limit = 30) {
  const evtSeriesKeys = new Set();
  const posSeriesKeys = new Set();
  const posWeights = new Map();

  for (const e of events) {
    const entry = catMap.get(String(e.animeId));
    if (!entry) continue;
    evtSeriesKeys.add(entry.seriesKey);
    if (["masterpiece","interesting","like","seed","wishlist"].includes(e.action)) {
      posSeriesKeys.add(entry.seriesKey);
      posWeights.set(entry.seriesKey, Math.max(posWeights.get(entry.seriesKey) || 0,
        e.action === "masterpiece" ? 1.3 : e.action === "like" ? 0.78 : e.action === "seed" ? 0.72 : 0.46));
    }
  }

  if (posSeriesKeys.size === 0) {
    const seen = new Set();
    const sorted = [...catalog].sort(
      (a, b) => (Math.log1p(b.members) + Math.max(0, (b.year||2000) - 2015) * 0.02) -
                (Math.log1p(a.members) + Math.max(0, (a.year||2000) - 2015) * 0.02));
    const result = [];
    for (const a of sorted) {
      if (seen.has(a.seriesKey)) continue;
      seen.add(a.seriesKey);
      result.push({...a, reasons: ["Popular recommendation"], channel: "Hot"});
      if (result.length >= limit) break;
    }
    return result;
  }

  const likedSeries = [...posSeriesKeys];
  const likedEntries = likedSeries.map(sk => catalog.find(a => a.seriesKey === sk && idToIndex.has(String(a.id)))).filter(Boolean);
  const likedItems = likedEntries.map(e => idToIndex.get(String(e.id))).filter(i => i !== undefined);

  const clusterCentroids = [];
  if (likedItems.length <= 4) {
    const vecs = likedItems.map(i => factors[i]);
    const ws = likedItems.map((_, i) => {
      const id = modelData.ids[likedItems[i]];
      return Math.min(1, (posWeights.get(likedSeries[i] || '') || 0.5) / 0.72);
    });
    clusterCentroids.push(centroid(vecs, ws));
  } else {
    const assigned = new Set();
    for (let i = 0; i < likedItems.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i]; assigned.add(i);
      for (let j = i + 1; j < likedItems.length; j++) {
        if (assigned.has(j)) continue;
        if (cosine(factors[likedItems[i]], factors[likedItems[j]]) > 0.35) { cluster.push(j); assigned.add(j); }
      }
      const vecs = cluster.map(ci => factors[likedItems[ci]]);
      const ws = cluster.map(ci => {
        const id = modelData.ids[likedItems[ci]];
        return Math.min(1, (posWeights.get(likedSeries[ci] || '') || 0.5) / 0.72);
      });
      clusterCentroids.push(centroid(vecs, ws));
      if (clusterCentroids.length >= 3) {
        const rest = [];
        for (let j = 0; j < likedItems.length; j++) if (!assigned.has(j)) rest.push(j);
        if (rest.length > 0) {
          clusterCentroids.push(centroid(
            rest.map(i => factors[likedItems[i]]),
            rest.map(i => Math.min(1, (posWeights.get(likedSeries[i] || '') || 0.5) / 0.72))
          ));
        }
        break;
      }
    }
  }

  const scores = [];
  for (let i = 0; i < nItems; i++) {
    const id = String(modelData.ids[i]);
    const entry = catMap.get(id);
    if (!entry) continue;
    if (evtSeriesKeys.has(entry.seriesKey)) continue;
    let best = -Infinity;
    for (const c of clusterCentroids) {
      const s = dot(factors[i], c);
      if (s > best) best = s;
    }
    const members = entry.members || 1;
    const popBonus = Math.min(0.12, Math.log1p(members) / Math.log1p(50000) * 0.12);
    const yearBonus = entry.year > 2015 ? Math.min(0.10, (entry.year - 2015) * 0.01) : 0;
    const noveltyBonus = Math.max(0, (1 - Math.log1p(members) / Math.log1p(50000)) * 0.06);
    scores.push({ id, seriesKey: entry.seriesKey, score: best + popBonus + yearBonus + noveltyBonus });
  }

  const avoided = new Set();
  for (const e of events) {
    const entry = catMap.get(String(e.animeId));
    if (entry && ["avoid","terrible","mild_dislike"].includes(e.action)) avoided.add(entry.seriesKey);
  }
  if (avoided.size > 0) {
    for (const s of scores) {
      const ci = idToIndex.get(String(s.id));
      if (ci === undefined) continue;
      let maxSim = 0;
      for (const ask of avoided) {
        const aEntry = catalog.find(a => a.seriesKey === ask && idToIndex.has(String(a.id)));
        if (!aEntry) continue;
        const ai = idToIndex.get(String(aEntry.id));
        if (ai === undefined) continue;
        if (cosine(factors[ci], factors[ai]) > maxSim) maxSim = cos(factors[ci], factors[ai]);
      }
      if (maxSim > 0.35) s.score -= (maxSim - 0.35) * 0.6;
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const result = [];
  const used = new Set();
  for (const s of scores) {
    if (result.length >= limit) break;
    if (used.has(s.seriesKey)) continue;
    used.add(s.seriesKey);
    const entry = catMap.get(String(s.id));
    if (!entry) continue;

    const similar = [...posSeriesKeys].map(sk => {
      const e = catalog.find(a => a.seriesKey === sk && idToIndex.has(String(a.id)));
      if (!e) return null;
      const pi = idToIndex.get(String(e.id)), ci = idToIndex.get(String(s.id));
      if (pi === undefined || ci === undefined) return null;
      return { title: e.title, s: cosine(factors[pi], factors[ci]) };
    }).filter(Boolean).sort((a,b) => b.s - a.s).slice(0, 2);

    result.push({
      ...entry,
      reasons: similar.length > 0
        ? [`Because you liked "${similar[0].title}"`, similar.length > 1 ? `and "${similar[1].title}"` : ""].filter(Boolean)
        : ["Recommended based on your taste profile"],
      channel: likedItems.length <= 3 ? "Core Taste" : `${clusterCentroids.length} interest clusters`,
    });
  }
  return result;
}

// ─── Web Server ───
createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/v2" || url.pathname === "/v2/" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(resolve(__dirname, "src", "app", "page.html"), "utf8"));
    return;
  }

  if (url.pathname === "/api/v2/onboarding") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: getSeedCards(20) }));
    return;
  }

  if (url.pathname === "/api/v2/recommendations" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { events, limit } = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: recommend(events, limit || 30) }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/api/v2/features") {
    const titles = {};
    for (const a of catalog) if (a.title) titles[a.id] = a.title;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dim: 0, titles, count: Object.keys(titles).length }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, () => {
  console.log(`V2 Server: http://localhost:${PORT}/v2`);
});
