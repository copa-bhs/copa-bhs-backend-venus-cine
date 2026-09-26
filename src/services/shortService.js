/**
 * MÓDULO DE SHORTS (ReelShort)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.SHORTS_PORT || 3001;
const BASE = process.env.REELSHORT_BASE_URL || 'https://www.reelshort.com';
const LANG = process.env.REELSHORT_LANG || 'pt';
const CACHE_TTL = parseInt(process.env.REELSHORT_CACHE_TTL || '600', 10);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Referer': BASE + '/',
};

const MAX_CACHE = 200;
const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, item);
  return item.value;
}

function cacheSet(key, value, ttlSeconds = CACHE_TTL) {
  if (cache.has(key)) cache.delete(key);
  while (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

function normalizeImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return '';
  if (url.startsWith('/_next/image')) {
    try {
      const u = new URL(url, BASE);
      const real = u.searchParams.get('url');
      if (real) return decodeURIComponent(real);
    } catch (_) {}
  }
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return BASE + url;
  return url;
}

function extractImageUrl($img) {
  if (!$img || !$img.length) return '';
  const dataNimg = $img.attr('data-nimg');
  if (dataNimg && dataNimg.startsWith('http')) return normalizeImageUrl(dataNimg);
  for (const attr of ['srcset', 'data-srcset']) {
    const v = $img.attr(attr);
    if (v) {
      const parts = v.split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean);
      if (parts.length) {
        const last = parts[parts.length - 1];
        if (last && !last.startsWith('data:')) return normalizeImageUrl(last);
      }
    }
  }
  for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-image']) {
    const v = $img.attr(attr);
    if (v && !v.startsWith('data:')) return normalizeImageUrl(v);
  }
  const src = $img.attr('src') || '';
  if (src && !src.startsWith('data:') && src.length > 20) return normalizeImageUrl(src);
  return '';
}

function proxyImageUrl(rawUrl) {
  if (!rawUrl) return '';
  return `/api/proxy-image?url=${encodeURIComponent(rawUrl)}`;
}

async function fetchHTML(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 25000 });
  return data;
}

function extractJSONLD($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (data['@graph']) nodes.push(...data['@graph']);
      else if (Array.isArray(data)) nodes.push(...data);
      else nodes.push(data);
    } catch (_) {}
  });
  return nodes;
}

async function searchShorts(query) {
  const key = `search:${query.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${BASE}/${LANG}/search?keywords=${encodeURIComponent(query)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const seen = new Set();
  const results = [];

  $('a[href*="/movie/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') || '';
    const m = href.match(/\/movie\/([^\/?#]+)/);
    if (!m) return;
    const slug = m[1];
    if (seen.has(slug)) return;
    seen.add(slug);

    const img = a.find('img').first();
    let title = (a.attr('title') || img.attr('alt') || a.text() || '').trim().replace(/\s+/g, ' ');
    title = title.replace(/^(assistir|ver|watch)\s+/i, '').trim();
    if (!title || title.length < 2) return;

    let cover = extractImageUrl(img);
    if (!cover) {
      a.find('img').each((__, other) => {
        if (cover) return;
        const u = extractImageUrl($(other));
        if (u) cover = u;
      });
    }
    if (!cover) {
      const rawHtml = a.html() || '';
      const rgx = rawHtml.match(/https:\/\/v-(?:img|mps)\.crazymaplestudios\.com\/[^\s"')]+\.(?:jpg|jpeg|png|webp)/i);
      if (rgx) cover = rgx[0];
    }

    results.push({
      slug,
      title: title.slice(0, 120),
      cover,
      coverProxy: proxyImageUrl(cover),
      url: `${BASE}/${LANG}/movie/${slug}`,
    });
  });

  const sliced = Array.isArray(results) ? results.slice(0, 40) : [];
  cacheSet(key, sliced);
  return sliced;
}

async function getShort(slug) {
  const key = `short:${slug}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${BASE}/${LANG}/movie/${slug}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const nodes = extractJSONLD($);

  let title = '';
  let cover = '';
  let description = '';
  let tags = [];

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n['@type'] === 'TVSeries') {
      title = n.name || title;
      description = n.description || description;
    }
    if (n['@type'] === 'ImageObject' && !cover) cover = n.contentUrl;
    if (n['@type'] === 'BreadcrumbList') {
      tags = (n.itemListElement || []).map(i => i?.name).filter(Boolean);
    }
  }

  if (!cover) {
    const img = $('img[alt]').first();
    cover = extractImageUrl(img);
  }

  const episodes = [];
  const seen = new Set();

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n['@type'] === 'TVEpisode') {
      const epUrl = n.url || n['@id'];
      if (epUrl && !seen.has(epUrl)) {
        seen.add(epUrl);
        episodes.push({
          number: n.episodeNumber || episodes.length + 1,
          title: n.name || 'Episódio',
          duration: n.duration || '',
          description: n.description || '',
          thumbnail: n.thumbnailUrl || '',
          url: epUrl?.startsWith('http') ? epUrl : BASE + epUrl,
        });
      }
    }
  }

  if (episodes.length === 0) {
    $('a[href*="/episodes/"]').each((_, el) => {
      const a = $(el);
      const href = a.attr('href') || '';
      const m = href.match(/\/episodes\/([^\/?#]+)/);
      if (!m || seen.has(href)) return;
      seen.add(href);
      const t = (a.attr('title') || a.text() || '').trim() || 'Episódio';
      const numMatch = t.match(/(\d+)/);
      episodes.push({
        number: numMatch ? parseInt(numMatch[1], 10) : episodes.length + 1,
        title: t,
        duration: '',
        description: '',
        thumbnail: '',
        url: href?.startsWith('http') ? href : BASE + href,
      });
    });
  }

  if (Array.isArray(episodes)) episodes.sort((a, b) => (a.number || 0) - (b.number || 0));

  if (episodes.length === 0) {
    $('a[href*="chapter"]').each((_, el) => {
      const a = $(el);
      const href = a.attr('href') || '';
      if (!href || seen.has(href)) return;
      seen.add(href);
      const t = (a.attr('title') || a.text() || '').trim() || 'Episódio';
      episodes.push({
        number: episodes.length + 1,
        title: t,
        duration: '',
        description: '',
        thumbnail: '',
        url: href?.startsWith('http') ? href : BASE + href,
      });
    });
  }

  const result = {
    slug,
    title,
    cover,
    coverProxy: proxyImageUrl(cover),
    description,
    tags,
    totalEpisodes: episodes.length,
    episodes,
  };

  cacheSet(key, result);
  return result;
}

async function getEpisode(url) {
  if (!url || !url.includes('reelshort.com')) throw new Error('URL inválida');
  const key = `ep:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const nodes = extractJSONLD($);

  let title = '';
  let description = '';
  let duration = '';
  let thumbnail = '';
  let videoUrl = '';

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const t = n['@type'];
    if (t === 'VideoObject' || (Array.isArray(t) && t.includes('VideoObject'))) {
      title = n.name || title;
      description = n.description || description;
      duration = n.duration || duration;
      thumbnail = n.thumbnailUrl || thumbnail;
      videoUrl = n.contentUrl || videoUrl;
    }
    if (t === 'TVEpisode') {
      title = n.name || title;
      description = n.description || description;
    }
  }

  const result = {
    title,
    description,
    duration,
    thumbnail,
    videoUrl,
    videoUrlProxy: videoUrl ? `/api/stream?url=${encodeURIComponent(videoUrl)}` : '',
    pageUrl: url,
  };

  cacheSet(key, result);
  return result;
}

async function getTrending() {
  const key = 'trending';
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${BASE}/${LANG}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const seen = new Set();
  const results = [];

  $('a[href*="/movie/"]').each((_, el) => {
    if (results.length >= 20) return;
    const a = $(el);
    const href = a.attr('href') || '';
    const m = href.match(/\/movie\/([^\/?#]+)/);
    if (!m) return;
    const slug = m[1];
    if (seen.has(slug)) return;
    seen.add(slug);

    const img = a.find('img').first();
    let title = (a.attr('title') || img.attr('alt') || '').trim();
    if (!title || title.length < 2) return;

    let cover = extractImageUrl(img);
    if (!cover) {
      const rawHtml = a.html() || '';
      const rgx = rawHtml.match(/https:\/\/v-(?:img|mps)\.crazymaplestudios\.com\/[^\s"')]+\.(?:jpg|jpeg|png|webp)/i);
      if (rgx) cover = rgx[0];
    }

    results.push({
      slug,
      title: title.slice(0, 120),
      cover,
      coverProxy: proxyImageUrl(cover),
      url: `${BASE}/${LANG}/movie/${slug}`,
    });
  });

  cacheSet(key, Array.isArray(results) ? results : [], 1800);
  return Array.isArray(results) ? results : [];
}

async function proxyImage(targetUrl, res) {
  const allowed = ['crazymaplestudios.com', 'reelshort.com', 'cmastudios.com'];
  if (!allowed.some(d => targetUrl?.includes(d))) {
    return res.status(403).json({ error: 'Domínio não permitido' });
  }
  const response = await axios.get(targetUrl, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': BASE + '/', 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8' },
    timeout: 20000,
  });
  const ctype = response.headers['content-type'] || 'image/jpeg';
  res.set('Content-Type', ctype);
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(Buffer.from(response.data));
}

async function proxyStream(targetUrl, res) {
  const allowed = ['crazymaplestudios.com', 'reelshort.com', 'cmastudios.com'];
  if (!allowed.some(d => targetUrl?.includes(d))) {
    return res.status(403).json({ error: 'Domínio não permitido' });
  }
  const response = await axios.get(targetUrl, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': BASE + '/', 'Accept': '*/*' },
    timeout: 30000,
  });
  let ctype = 'application/octet-stream';
  if (targetUrl?.includes('.m3u8')) ctype = 'application/vnd.apple.mpegurl';
  else if (targetUrl?.includes('.ts')) ctype = 'video/mp2t';
  else if (targetUrl?.includes('.mp4')) ctype = 'video/mp4';
  res.set('Content-Type', ctype);
  res.set('Access-Control-Allow-Origin', '*');
  res.send(Buffer.from(response.data));
}

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, module: 'shorts', uptime: process.uptime(), cacheSize: cache.size });
});

app.get('/api/shorts/trending', async (_req, res) => {
  try {
    const items = await getTrending();
    res.json({ total: items?.length || 0, items: Array.isArray(items) ? items : [] });
  } catch (e) {
    console.error('[trending] erro:', e?.message);
    res.status(500).json({ error: e?.message, items: [] });
  }
});

app.get('/api/shorts/search', async (req, res) => {
  try {
    const q = (req.query?.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'parâmetro q é obrigatório' });
    const items = await searchShorts(q);
    res.json({ query: q, total: items?.length || 0, items: Array.isArray(items) ? items : [] });
  } catch (e) {
    console.error('[search] erro:', e?.message);
    res.status(500).json({ error: e?.message, items: [] });
  }
});

app.get('/api/shorts/:slug', async (req, res) => {
  try {
    const data = await getShort(req.params?.slug);
    res.json(data);
  } catch (e) {
    console.error('[getShort] erro:', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

app.get('/api/shorts/episode', async (req, res) => {
  try {
    const url = (req.query?.url || '').toString();
    if (!url) return res.status(400).json({ error: 'parâmetro url é obrigatório' });
    const data = await getEpisode(url);
    res.json(data);
  } catch (e) {
    console.error('[getEpisode] erro:', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

app.get('/api/proxy-image', async (req, res) => {
  try {
    const url = (req.query?.url || '').toString();
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'url inválida' });
    await proxyImage(url, res);
  } catch (e) {
    console.error('[proxy-image] erro:', e?.message);
    res.status(502).json({ error: e?.message });
  }
});

app.get('/api/stream', async (req, res) => {
  try {
    const url = (req.query?.url || '').toString();
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'url inválida' });
    await proxyStream(url, res);
  } catch (e) {
    console.error('[proxy-stream] erro:', e?.message);
    res.status(502).json({ error: e?.message });
  }
});

app.post('/api/admin/clear-cache', (_req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'Cache limpo' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

app.listen(PORT, () => {
  console.log(`\n🎬 ReelShort Shorts API`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → Health:  http://localhost:${PORT}/health`);
  console.log(`   → Trending: http://localhost:${PORT}/api/shorts/trending`);
  console.log(`   → Search:   http://localhost:${PORT}/api/shorts/search?q=liga\n`);
});

module.exports = { app, getTrending, searchShorts, getShort, getEpisode, proxyImage, proxyStream };
