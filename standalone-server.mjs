// V2 standalone server — merged series mode
// 用法: node v2/standalone-server.mjs [--port=3002]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv.find(a => a.startsWith("--port="))?.slice(7) || "3002");

// ─── Load data ───
const catalog = JSON.parse(readFileSync(resolve(__dirname, "data", "catalog", "expanded-anime.json"), "utf8"));
const modelData = JSON.parse(readFileSync(resolve(__dirname, "data", "models", "bpr-items.json"), "utf8"));
const factors = modelData.item_factors;
const nItems = modelData.n_items;

// Anime ID → Series ID lookup (maps user event IDs to merged series IDs)
const animeToSeries = JSON.parse(readFileSync(resolve(__dirname, "data", "catalog", "anime-to-series.json"), "utf8"));

// Series ID → model index
const idToIndex = new Map();
modelData.ids.forEach((id, i) => idToIndex.set(id, i));

console.log(`V2 Server: catalog=${catalog.length} series model=${nItems}x${factors[0].length}D port=${PORT}`);

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

// ─── Resolve anime ID → series ID ───
function resolveSeries(animeId) {
  return animeToSeries[animeId] || animeId;
}

// ─── Seed cards (DPP diversity sampling) ───
function getSeedCards(count) {
  const pool = catalog.filter(a => (a.members || 0) > 5000 && a.score > 7.5 && a.year >= 2000 && a.year <= 2024);
  if (pool.length < count) return catalog.sort((a, b) => b.members - a.members).slice(0, count);

  // k-means++ style diversity selection
  const result = [];
  const first = pool.find(a => a.score > 8.5 && a.members > 30000) || pool[0];
  result.push(first);
  const indices = [pool.indexOf(first)];

  while (result.length < count) {
    let bestD2 = -1, bestIdx = -1;
    for (let i = 0; i < pool.length; i++) {
      if (indices.includes(i)) continue;
      const ai = idToIndex.get(pool[i].id);
      if (ai === undefined) continue;
      let minD2 = Infinity;
      for (const j of indices) {
        const aj = idToIndex.get(pool[j].id);
        if (aj === undefined) continue;
        const cosSim = cosine(factors[ai], factors[aj]);
        const d2 = 1 - cosSim;
        if (d2 < minD2) minD2 = d2;
      }
      minD2 = minD2 * (1 + Math.random() * 0.3);
      if (minD2 > bestD2) { bestD2 = minD2; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    result.push(pool[bestIdx]);
    indices.push(bestIdx);
  }
  return result.slice(0, count);
}

// ─── Recommend ───
function recommend(events, limit = 30) {
  // Map event anime IDs to series IDs
  const seriesEvents = events.map(e => ({
    ...e,
    seriesId: resolveSeries(e.animeId),
  }));

  const evtSeriesIds = new Set(seriesEvents.map(e => e.seriesId));
  const posSeriesIds = new Set();
  const posWeights = new Map();

  const catalogMap = new Map(catalog.map(a => [a.id, a]));

  for (const e of seriesEvents) {
    if (["masterpiece","interesting","like","seed","wishlist"].includes(e.action)) {
      posSeriesIds.add(e.seriesId);
      posWeights.set(e.seriesId, Math.max(posWeights.get(e.seriesId) || 0,
        e.action === "masterpiece" ? 1.3 : e.action === "like" ? 0.78 : e.action === "seed" ? 0.72 : 0.46));
    }
  }

  // Cold start: popularity
  if (posSeriesIds.size === 0) {
    const seenSeries = new Set();
    const sorted = [...catalog].sort((a, b) => (Math.log1p(b.members) + Math.max(0, (b.year||2000) - 2015) * 0.02) - (Math.log1p(a.members) + Math.max(0, (a.year||2000) - 2015) * 0.02));
    const result = [];
    for (const a of sorted) {
      if (evtSeriesIds.has(a.id)) continue;
      if (seenSeries.has(a.id)) continue;
      seenSeries.add(a.id);
      result.push({...a, reasons: ["Popular recommendation"], channel: "Hot"});
      if (result.length >= limit) break;
    }
    return result;
  }

  // Build clusters in BPR space
  const posItems = [...posSeriesIds].map(id => idToIndex.get(id)).filter(i => i !== undefined);
  const clusterCentroids = [];

  if (posItems.length <= 3) {
    const vecs = posItems.map(i => factors[i]);
    const ws = posItems.map((_, i) => {
      const id = modelData.ids[posItems[i]];
      return Math.min(1, (posWeights.get(id) || 0.5) / 0.72);
    });
    clusterCentroids.push(centroid(vecs, ws));
  } else {
    const assigned = new Set();
    for (let i = 0; i < posItems.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i];
      assigned.add(i);
      for (let j = i + 1; j < posItems.length; j++) {
        if (assigned.has(j)) continue;
        const cs = cosine(factors[posItems[i]], factors[posItems[j]]);
        if (cs > 0.35) { cluster.push(j); assigned.add(j); }
      }
      const vecs = cluster.map(ci => factors[posItems[ci]]);
      const ws = cluster.map(ci => {
        const id = modelData.ids[posItems[ci]];
        return Math.min(1, (posWeights.get(id) || 0.5) / 0.72);
      });
      clusterCentroids.push(centroid(vecs, ws));
      if (clusterCentroids.length >= 3) {
        const rest = [];
        for (let j = 0; j < posItems.length; j++) if (!assigned.has(j)) rest.push(j);
        if (rest.length > 0) {
          const rVecs = rest.map(i => factors[posItems[i]]);
          const rWs = rest.map(i => {
            const id = modelData.ids[posItems[i]];
            return Math.min(1, (posWeights.get(id) || 0.5) / 0.72);
          });
          clusterCentroids.push(centroid(rVecs, rWs));
        }
        break;
      }
    }
  }

  // Score all candidates
  const scores = [];
  const maxCand = Math.min(4000, nItems);
  for (let i = 0; i < maxCand; i++) {
    const id = modelData.ids[i];
    if (evtSeriesIds.has(id)) continue;
    let best = -Infinity;
    for (const c of clusterCentroids) {
      const s = dot(factors[i], c);
      if (s > best) best = s;
    }
    scores.push({ id, score: best });
  }

  // Apply bonuses
  for (const s of scores) {
    const anime = catalogMap.get(s.id);
    if (!anime) continue;
    const popBonus = Math.min(0.12, Math.log1p(anime.members || 1) / Math.log1p(50000) * 0.12);
    const yearBonus = anime.year && anime.year > 2015 ? Math.min(0.10, (anime.year - 2015) * 0.01) : 0;
    s.score += popBonus + yearBonus;
    const popScore2 = Math.log1p(anime.members || 1) / Math.log1p(50000);
    const noveltyBonus = Math.max(0, (1 - popScore2) * 0.06);
    s.score += noveltyBonus;
  }

  // Negative penalty
  const avoidedIds = new Set();
  for (const e of seriesEvents) {
    if (["avoid","terrible","mild_dislike"].includes(e.action)) avoidedIds.add(e.seriesId);
  }
  if (avoidedIds.size > 0) {
    for (const s of scores) {
      const ci = idToIndex.get(s.id);
      if (ci === undefined) continue;
      let maxSim = 0;
      for (const aid of avoidedIds) {
        const ai = idToIndex.get(aid);
        if (ai === undefined) continue;
        const sim = cosine(factors[ci], factors[ai]);
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim > 0.35) s.score -= (maxSim - 0.35) * 0.6;
    }
  }

  scores.sort((a, b) => b.score - a.score);

  // Build results (no series dedup needed — already merged)
  const result = [];
  for (const { id } of scores) {
    if (result.length >= limit) break;
    const anime = catalogMap.get(id);
    if (!anime) continue;
    if (evtSeriesIds.has(id)) continue;

    const similar = [];
    for (const pid of posSeriesIds) {
      const pi = idToIndex.get(pid), ci = idToIndex.get(id);
      if (pi === undefined || ci === undefined) continue;
      const s = cosine(factors[pi], factors[ci]);
      similar.push({ title: catalogMap.get(pid)?.title || pid, s });
    }
    similar.sort((a, b) => b.s - a.s);
    const topSim = similar.slice(0, 2);

    result.push({
      ...anime,
      reasons: topSim.length > 0
        ? [`Because you liked \"${topSim[0].title}\"`, topSim.length > 1 ? `and \"${topSim[1].title}\"` : ""].filter(Boolean)
        : ["Recommended based on your taste profile"],
      channel: posItems.length <= 3 ? "Core Taste" : `${clusterCentroids.length} interest clusters`,
    });
  }
  return result;
}

// ─── Web Server ───
createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const catalogMap = new Map(catalog.map(a => [a.id, a]));

  if (url.pathname === "/v2" || url.pathname === "/v2/" || url.pathname === "/") {
    const html = readFileSync(resolve(__dirname, "src", "app", "page.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
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
        const items = recommend(events, limit || 30);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Features API — title index only (no embeddings)
  if (url.pathname === "/api/v2/features") {
    const titles = {};
    for (const a of catalog) {
      if (a.title) titles[a.id] = a.title;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dim: 0, titles, count: Object.keys(titles).length }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, () => {
  console.log(`V2 Server: http://localhost:${PORT}/v2`);
});
