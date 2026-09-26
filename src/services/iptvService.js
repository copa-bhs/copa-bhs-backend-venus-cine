/**
 * Serviço IPTV (Xtream Codes).
 * Baixa listas, filtra lixo e organiza por tipo.
 */
const axios = require('axios');
const cache = require('./cacheService');

const HEADERS = {
  'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
  'Accept': 'application/json, */*',
};

// Regex de filtro de lixo (adulto, teste, promo, etc.)
const BLACKLIST_PATTERNS = [
  /\b(adulto|adult|xxx|porn|sex|18\+|er[oó]tic)\b/i,
  /\b(teste|test|backup|off|indispon[ií]vel)\b/i,
  /\b(promo|promo[cç][aã]o|propaganda|ads?)\b/i,
];

function isJunk(name, category) {
  const txt = `${name || ''} ${category || ''}`;
  if (!txt.trim()) return true;
  return BLACKLIST_PATTERNS.some((re) => re.test(txt));
}

function detectType(name, category) {
  const c = String(category || '').toLowerCase();
  const n = String(name || '').toLowerCase();

  if (/filme|movie|cinema/.test(c)) return 'movie';
  if (/s[eé]rie|serie|series|novela|temporada/.test(c)) return 'tv';
  if (/canal|channel|ao vivo|live/.test(c)) return 'channel';
  if (/document[aá]rio|doc/.test(c)) return 'other';
  if (/infantil|kids|desenho|anime/.test(c)) return 'other';
  if (/esporte|sport/.test(c)) return 'other';
  if (/not[ií]cia|news/.test(c)) return 'other';

  if (/\bS\d{1,2}E\d{1,2}\b|\btemporada\b|\bseason\b/.test(n)) return 'tv';
  if (/\b(19|20)\d{2}\b/.test(n)) return 'movie';

  return 'other';
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\b(4K|FHD|HD|SD|DUB|LEG|DUBLADO|LEGENDADO|H264|H265|HEVC|UHD|FULLHD)\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[[\](){}|/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(raw) {
  const m = String(raw || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

// ─── URLs base ───
function getBase() {
  const url = process.env.IPTV_BASE_URL;
  const user = process.env.IPTV_USERNAME;
  const pass = process.env.IPTV_PASSWORD;
  if (!url || !user || !pass) {
    throw new Error('Credenciais IPTV não configuradas no .env');
  }
  return { url, user, pass };
}

function buildApiUrl(action, extra = {}) {
  const { url, user, pass } = getBase();
  const params = new URLSearchParams({
    username: user,
    password: pass,
    action,
    ...extra,
  });
  return `${url}/player_api.php?${params.toString()}`;
}

async function fetchJson(url, cacheKey, ttl) {
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 60000 });
  if (cacheKey) cache.set(cacheKey, data, ttl || 3600);
  return data;
}

// ─── Buscas brutas ───
async function getMovies() {
  const ttl = parseInt(process.env.IPTV_CACHE_TTL || '3600', 10);
  return fetchJson(buildApiUrl('get_vod_streams'), 'iptv:movies', ttl);
}

async function getSeries() {
  const ttl = parseInt(process.env.IPTV_CACHE_TTL || '3600', 10);
  return fetchJson(buildApiUrl('get_series'), 'iptv:series', ttl);
}

async function getChannels() {
  const ttl = parseInt(process.env.IPTV_CACHE_TTL || '3600', 10);
  return fetchJson(buildApiUrl('get_live_streams'), 'iptv:channels', ttl);
}

async function getVodCategories() {
  return fetchJson(buildApiUrl('get_vod_categories'), 'iptv:vodCats', 3600);
}

async function getSeriesCategories() {
  return fetchJson(buildApiUrl('get_series_categories'), 'iptv:seriesCats', 3600);
}

async function getLiveCategories() {
  return fetchJson(buildApiUrl('get_live_categories'), 'iptv:liveCats', 3600);
}

async function getSeriesInfo(seriesId) {
  const key = `iptv:seriesInfo:${seriesId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const url = buildApiUrl('get_series_info', { series_id: seriesId });
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
  cache.set(key, data, 600);
  return data;
}

// ─── Stream URLs ───
function buildStreamUrl(id, type = 'live') {
  const { url, user, pass } = getBase();
  if (type === 'movie') return `${url}/movie/${user}/${pass}/${id}.mp4`;
  if (type === 'series') return `${url}/series/${user}/${pass}/${id}.mp4`;
  return `${url}/live/${user}/${pass}/${id}.m3u8`;
}

// ─── Lista organizada ───
async function getOrganizedList() {
  const cacheKey = 'iptv:organized';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Busca em paralelo, cada um com fallback vazio
  const [moviesRaw, seriesRaw, channelsRaw, vodCats, seriesCats, liveCats] =
    await Promise.all([
      getMovies().catch(() => []),
      getSeries().catch(() => []),
      getChannels().catch(() => []),
      getVodCategories().catch(() => []),
      getSeriesCategories().catch(() => []),
      getLiveCategories().catch(() => []),
    ]);

  // Mapas de categoria
  const catMap = {};
  const safeCats = (arr) => (Array.isArray(arr) ? arr : []);

  const addCat = (c) => {
    if (!c) return;
    const id = String(c.category_id ?? '').trim();
    const name = String(c.category_name ?? '').trim();
    if (id && name) catMap[id] = name;
  };

  console.log('[iptv] Categorias brutas:', {
    vod: Array.isArray(vodCats) ? vodCats.length : 'N/A',
    series: Array.isArray(seriesCats) ? seriesCats.length : 'N/A',
    live: Array.isArray(liveCats) ? liveCats.length : 'N/A',
  });

  safeCats(vodCats).forEach(addCat);
  safeCats(seriesCats).forEach(addCat);
  safeCats(liveCats).forEach(addCat);

  console.log('[iptv] catMap montado:', {
    total: Object.keys(catMap).length,
    primeiros5: Object.entries(catMap).slice(0, 5),
  });

  const byType = {
    movie: [],
    tv: [],
    channel: [],
    other: [],
  };
  const byCategory = {};

  const addItem = (item, forcedType) => {
    const name = String(item?.name || item?.title || '').trim();
    if (!name) return;

    const catIdStr = String(item?.category_id ?? '').trim();
    const category = catMap[catIdStr] || `Categoria ${catIdStr}` || 'Sem categoria';
    console.log(`[iptv] addItem: ${name} → cat=${category} (id=${catIdStr})`);
    if (isJunk(name, category)) return;

    const type = forcedType || detectType(name, category);
    const obj = {
      id: String(item?.stream_id || item?.series_id || ''),
      name,
      title: cleanTitle(name) || name,
      cover: item?.stream_icon || item?.cover || '',
      backdrop: item?.backdrop_path || item?.background || '',
      overview: item?.plot || item?.description || '',
      year: extractYear(name),
      category,
      categoryId: item?.category_id || null,
      categorySlug: category
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
      type,
    };

    if (byType[type]) byType[type].push(obj);
    else byType.other.push(obj);

    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(obj);
  };

  safeCats(moviesRaw).forEach((m) => addItem(m, 'movie'));
  safeCats(seriesRaw).forEach((s) => addItem(s, 'tv'));
  safeCats(channelsRaw).forEach((c) => addItem(c, 'channel'));

  const total = byType.movie.length + byType.tv.length + byType.channel.length + byType.other.length;

  const result = {
    total,
    counts: {
      movies: byType.movie.length,
      series: byType.tv.length,
      channels: byType.channel.length,
      other: byType.other.length,
    },
    categories: Object.keys(byCategory).sort(),
    byType,
    byCategory,
  };

  console.log('[iptv] Lista organizada:', {
    total: total,
    counts: {
      movies: byType.movie.length,
      series: byType.tv.length,
      channels: byType.channel.length,
      other: byType.other.length,
    },
    categorias: Object.keys(byCategory).length,
    exemplosCategorias: Object.keys(byCategory).slice(0, 10),
  });

  console.log('[iptv] Resultado final:', {
    total,
    movies: byType.movie.length,
    series: byType.tv.length,
    channels: byType.channel.length,
    categorias: Object.keys(byCategory).length,
    primeirasCategorias: Object.keys(byCategory).slice(0, 5),
    exemploItem: byType.movie[0] ? {
      name: byType.movie[0].name,
      category: byType.movie[0].category,
      categoryId: byType.movie[0].categoryId,
    } : null,
  });

  cache.set(cacheKey, result, parseInt(process.env.IPTV_CACHE_TTL || '3600', 10));
  return result;
}

function getCategoriesByType(organized, type) {
  if (!organized || !organized.byCategory) return [];
  const result = [];
  Object.entries(organized.byCategory).forEach(([name, items]) => {
    const safeItems = Array.isArray(items) ? items : [];
    if (safeItems.length === 0) return;
    const itemType = safeItems[0]?.type;
    if (itemType === type) {
      result.push({
        name,
        slug: safeItems[0]?.categorySlug || '',
        count: safeItems.length,
        type: itemType,
      });
    }
  });
  return result.sort((a, b) => b.count - a.count);
}

module.exports = {
  getOrganizedList,
  getMovies,
  getSeries,
  getChannels,
  getSeriesInfo,
  buildStreamUrl,
  cleanTitle,
  extractYear,
  detectType,
  isJunk,
  getCategoriesByType,
};