// V2 standalone server — GPT-cleaned Bangumi catalog
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || process.argv.find(a => a.startsWith("--port="))?.slice(7) || "3002");
const t0 = Date.now();

// ─── Load & normalize catalog ───
const rawCatalog = JSON.parse(readFileSync(resolve(__dirname, "data", "catalog", "expanded-anime.json"), "utf8"));
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
}));

// ─── Load BPR model ───
const modelData = JSON.parse(readFileSync(resolve(__dirname, "data", "models", "bpr-items.json"), "utf8"));
const factors = modelData.item_factors;
const nItems = modelData.n_items;

const idToIndex = new Map();
modelData.ids.forEach((id, i) => idToIndex.set(String(id), i));
const catMap = new Map(catalog.map(a => [a.id, a]));

// Pre-index: seriesKey → best catalog entry ID that's in the model
const seriesIndex = new Map();
for (const a of catalog) {
  if (!idToIndex.has(a.id)) continue;
  if (!seriesIndex.has(a.seriesKey) || a.members > (catMap.get(seriesIndex.get(a.seriesKey))?.members || 0)) {
    seriesIndex.set(a.seriesKey, a.id);
  }
}

console.log(`Server init: ${catalog.length} items x ${factors[0].length}D in ${Date.now()-t0}ms port=${PORT}`);

// ─── Math utils ───
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function cosine(a, b) { const d = dot(a, b); return d / (Math.sqrt(dot(a,a)) * Math.sqrt(dot(b,b)) + 1e-8); }
function centroid(items, weights) {
  const dim = items[0].length;
  const c = new Array(dim).fill(0);
  let tw = 0;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i];
    for (let d = 0; d < dim; d++) c[d] += items[i][d] * w;
    tw += w;
  }
  if (tw > 0) for (let d = 0; d < dim; d++) c[d] /= tw;
  return c;
}

// ─── Seed cards: large rotating pool, show 20 ───
function getSeedCards(show) {
  const seedNames = [
    "命运石之门", "魔法少女小圆", "星际牛仔", "龙与虎", "冰菓",
    "新世纪福音战士", "Code Geass 反叛的鲁路修", "CLANNAD", "死亡笔记",
    "Fate/Zero", "Fate/stay night", "刀剑神域", "Re：从零开始的异世界生活",
    "鬼灭之刃", "咒术回战", "孤独摇滚！", "间谍过家家",
    "进击的巨人", "千与千寻", "哈尔的移动城堡", "你的名字。",
    "名侦探柯南", "航海王", "龙猫", "幽灵公主", "天空之城",
    "银魂", "夏目友人帐", "化物语", "魔法禁书目录",
    "凉宫春日的忧郁", "钢之炼金术师", "未闻花名",
    "四月是你的谎言", "吹响吧！上低音号", "一拳超人",
    "辉夜大小姐想让我告白", "无职转生", "葬送的芙莉莲",
    "更衣人偶坠入爱河", "败犬女主太多了！",
    "BanG Dream! It's MyGO!!!!!", "【我推的孩子】",
    "秒速5厘米", "天气之子", "铃芽之旅", "排球少年", "灌篮高手",
    "K-ON!", "Angel Beats!",
  ];

  const usedSeries = new Set();
  const pool = [];

  for (const name of seedNames) {
    const matches = catalog.filter(a => a.title === name);
    if (!matches.length) continue;
    let best = null;
    for (const m of matches) {
      if (usedSeries.has(m.seriesKey)) continue;
      if (!best || m.members > (best.members || 0)) best = m;
    }
    if (best) { usedSeries.add(best.seriesKey); pool.push(best); }
  }

  // Top up with popular anime for variety
  const popular = [...catalog]
    .filter(a => a.members > 5000 && a.score >= 7.0 && a.year >= 1995 && a.year <= 2025)
    .sort((a, b) => b.members - a.members);

  for (const a of popular) {
    if (usedSeries.has(a.seriesKey)) continue;
    usedSeries.add(a.seriesKey);
    pool.push(a);
    if (pool.length >= 200) break; // large variety pool
  }

  // Shuffle and take 'show' cards
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, show);
}

// ─── Recommend ───
function recommend(events, limit) {
  limit = limit || 30;
  const evtSK = new Set();
  const posSK = new Set();
  const posW = new Map();
  const avoidedSK = new Set();

  for (const e of events) {
    const entry = catMap.get(String(e.animeId));
    if (!entry) continue;
    evtSK.add(entry.seriesKey);
    if (["masterpiece","interesting","like","seed","wishlist"].includes(e.action)) {
      posSK.add(entry.seriesKey);
      posW.set(entry.seriesKey, Math.max(posW.get(entry.seriesKey) || 0,
        e.action === "masterpiece" ? 1.3 : e.action === "like" ? 0.78 : e.action === "seed" ? 0.72 : 0.46));
    }
    if (["avoid","terrible","mild_dislike"].includes(e.action)) avoidedSK.add(entry.seriesKey);
  }

  // Cold start
  if (posSK.size === 0) {
    const seen = new Set();
    const result = [];
    for (const a of [...catalog].sort((a, b) => b.members - a.members)) {
      if (seen.has(a.seriesKey)) continue;
      seen.add(a.seriesKey);
      result.push({...a, reasons: ["Popular recommendation"], channel: "Hot"});
      if (result.length >= limit) break;
    }
    return result;
  }

  // Build liked items list (one per posSK, using seriesIndex for O(1) lookup)
  const likedSKs = [...posSK];
  const likedItems = [];
  const likedEntries = [];
  for (const sk of likedSKs) {
    const mid = seriesIndex.get(sk);
    if (!mid) continue;
    const idx = idToIndex.get(mid);
    if (idx === undefined) continue;
    likedItems.push(idx);
    likedEntries.push(catMap.get(mid));
  }

  // Cluster
  const centroids = [];
  if (likedItems.length <= 4) {
    centroids.push(centroid(
      likedItems.map(i => factors[i]),
      likedItems.map((_, i) => Math.min(1, (posW.get(likedSKs[i]) || 0.5) / 0.72))
    ));
  } else {
    const assigned = new Set();
    for (let i = 0; i < likedItems.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i]; assigned.add(i);
      for (let j = i + 1; j < likedItems.length; j++) {
        if (assigned.has(j)) continue;
        if (cosine(factors[likedItems[i]], factors[likedItems[j]]) > 0.35) { cluster.push(j); assigned.add(j); }
      }
      centroids.push(centroid(
        cluster.map(ci => factors[likedItems[ci]]),
        cluster.map(ci => Math.min(1, (posW.get(likedSKs[ci]) || 0.5) / 0.72))
      ));
      if (centroids.length >= 3) {
        const rest = [];
        for (let j = 0; j < likedItems.length; j++) if (!assigned.has(j)) rest.push(j);
        if (rest.length > 0) centroids.push(centroid(
          rest.map(i => factors[likedItems[i]]),
          rest.map(i => Math.min(1, (posW.get(likedSKs[i]) || 0.5) / 0.72))
        ));
        break;
      }
    }
  }

  // Pre-compute avoided model indices
  const avoidedIdxs = [];
  for (const sk of avoidedSK) {
    const mid = seriesIndex.get(sk);
    if (!mid) continue;
    const idx = idToIndex.get(mid);
    if (idx !== undefined) avoidedIdxs.push(idx);
  }

  // Score all candidates
  const scores = [];
  for (let i = 0; i < nItems; i++) {
    const id = String(modelData.ids[i]);
    const entry = catMap.get(id);
    if (!entry) continue;
    if (evtSK.has(entry.seriesKey)) continue;

    let best = -Infinity;
    for (const c of centroids) {
      const s = dot(factors[i], c);
      if (s > best) best = s;
    }

    let penalty = 0;
    if (avoidedIdxs.length > 0) {
      let maxSim = 0;
      for (const ai of avoidedIdxs) {
        const sim = cosine(factors[i], factors[ai]);
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim > 0.75) penalty = (maxSim - 0.75) * 0.25;
    }

    const m = entry.members || 1;
    const popBonus = Math.min(0.12, Math.log1p(m) / Math.log1p(50000) * 0.12);
    const yearBonus = entry.year > 2015 ? Math.min(0.10, (entry.year - 2015) * 0.01) : 0;
    const novelBonus = Math.max(0, (1 - Math.log1p(m) / Math.log1p(50000)) * 0.06);

    scores.push({ id, seriesKey: entry.seriesKey, score: best + popBonus + yearBonus + novelBonus - penalty });
  }

  // Sort, dedup, build results
  scores.sort((a, b) => b.score - a.score);

  // Pre-resolve reason entries
  const reasonEntries = likedSKs.map(sk => {
    const mid = seriesIndex.get(sk);
    return mid ? catMap.get(mid) : null;
  }).filter(Boolean);

  const result = [];
  const used = new Set();
  for (const s of scores) {
    if (result.length >= limit) break;
    if (used.has(s.seriesKey)) continue;
    used.add(s.seriesKey);
    const entry = catMap.get(String(s.id));
    if (!entry) continue;

    const ci = idToIndex.get(String(s.id));
    const similar = ci !== undefined ? reasonEntries.map(e => {
      const pi = idToIndex.get(e.id);
      return pi !== undefined ? { title: e.title, s: cosine(factors[pi], factors[ci]) } : null;
    }).filter(Boolean).sort((a,b)=>b.s-a.s).slice(0,2) : [];

    result.push({
      ...entry,
      reasons: similar.length ? [`Because you liked "${similar[0].title}"`, similar.length>1?`and "${similar[1].title}"`:""].filter(Boolean)
        : ["Based on your taste profile"],
      channel: likedItems.length <= 3 ? "Core Taste" : `${centroids.length} interest clusters`,
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
        const tic = Date.now();
        const items = recommend(events, limit || 30);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items, _ms: Date.now() - tic }));
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
