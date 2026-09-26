/**
 * Rotas da API do Vênus Cine.
 * Todas as rotas têm try/catch robusto.
 */
const express = require('express');
const iptv = require('../services/iptvService');
const tmdb = require('../services/tmdbService');
const cache = require('../services/cacheService');

const router = express.Router();

// Helper de paginação segura
function paginate(arr, page, pageSize) {
  const safeArr = Array.isArray(arr) ? arr : [];
  const p = Math.max(1, parseInt(page) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize) || 20));
  const start = (p - 1) * ps;
  return {
    page: p,
    pageSize: ps,
    total: safeArr.length,
    totalPages: Math.ceil(safeArr.length / ps) || 1,
    items: safeArr.slice(start, start + ps),
  };
}

// ═══════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'development',
    cache: cache.stats(),
    tmdbConfigured: tmdb.isConfigured(),
  });
});

// ═══════════════════════════════════════════════════════════
// HOME (agregada — sem canais)
// ═══════════════════════════════════════════════════════════
router.get('/home', async (_req, res) => {
  try {
    const [trending, organized] = await Promise.all([
      tmdb.getTrending('all', 'week').catch(() => []),
      iptv.getOrganizedList().catch(() => null),
    ]);

    const movies = Array.isArray(organized?.byType?.movie) ? organized.byType.movie : [];
    const series = Array.isArray(organized?.byType?.tv) ? organized.byType.tv : [];

    console.log('[home] organized.counts:', organized?.counts);
    console.log('[home] organized.byCategory keys:', 
      organized?.byCategory ? Object.keys(organized.byCategory).length : 'N/A');

    let hero = Array.isArray(trending) && trending.length > 0 ? trending[0] : null;
    if (hero && hero.tmdbId) {
      const logo = await tmdb.getBestLogo(hero.tmdbId, hero.type).catch(() => '');
      if (logo) hero.logo = logo;
    }
    if (!hero && movies.length > 0) {
      const idx = Math.floor(Math.random() * Math.min(20, movies.length));
      hero = movies[idx];
    }

    const trendingSlice = Array.isArray(trending) ? trending.slice(0, 5) : [];
    const trendingWithLogos = await Promise.all(
      trendingSlice.map(async (item) => {
        if (!item?.tmdbId) return item;
        const logo = await tmdb.getBestLogo(item.tmdbId, item.type).catch(() => '');
        return { ...item, logo: logo || '' };
      })
    );

    const byCategory = organized?.byCategory || {};

    const movieCategories = Object.entries(byCategory)
      .map(([name, items]) => {
        const safeItems = Array.isArray(items) ? items : [];
        const onlyMovies = safeItems.filter((i) => i?.type === 'movie');
        return { name, items: onlyMovies, count: onlyMovies.length };
      })
      .filter((c) => c.count >= 5)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    console.log('[home] Categorias de filmes encontradas:', 
      movieCategories.map((c) => `${c.name} (${c.count})`));

    const seriesCategories = Object.entries(byCategory)
      .map(([name, items]) => {
        const safeItems = Array.isArray(items) ? items : [];
        const onlySeries = safeItems.filter((i) => i?.type === 'tv');
        return { name, items: onlySeries, count: onlySeries.length };
      })
      .filter((c) => c.count >= 5)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);

    const sections = [];

    sections.push({
      id: 'trending',
      title: 'Em alta',
      type: 'tmdb',
      items: trendingWithLogos,
    });

    movieCategories.forEach((cat) => {
      sections.push({
        id: `movie-cat-${cat.name.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')}`,
        title: cat.name,
        type: 'iptv',
        items: cat.items.slice(0, 20),
      });
    });

    seriesCategories.forEach((cat) => {
      sections.push({
        id: `series-cat-${cat.name.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')}`,
        title: cat.name,
        type: 'iptv',
        items: cat.items.slice(0, 20),
      });
    });

    if (movies.length > 0) {
      sections.push({
        id: 'movies-recent',
        title: 'Filmes recentes',
        type: 'iptv',
        items: movies.slice(0, 20),
      });

      const movieCats = {};
      movies.forEach((item) => {
        const c = item?.category || 'Sem categoria';
        if (!movieCats[c]) movieCats[c] = [];
        movieCats[c].push(item);
      });

      Object.entries(movieCats)
        .filter(([, arr]) => Array.isArray(arr) && arr.length >= 10)
        .slice(0, 4)
        .forEach(([name, arr]) => {
          const slug = String(name)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          sections.push({
            id: `movie-${slug}`,
            title: name,
            type: 'iptv',
            items: arr.slice(0, 20),
          });
        });
    }

    if (series.length > 0) {
      sections.push({
        id: 'series-recent',
        title: 'Séries em alta',
        type: 'iptv',
        items: series.slice(0, 20),
      });
    }

    res.json({
      hero: hero || {},
      sections: sections.slice(0, 12),
      categories: Object.keys(byCategory).map((name) => {
        const items = byCategory[name];
        const safeItems = Array.isArray(items) ? items : [];
        return {
          name,
          count: safeItems.length,
          type: safeItems[0]?.type || 'other',
          slug: name.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, ''),
        };
      }).sort((a, b) => b.count - a.count),
    });
  } catch (e) {
    console.error('[home] erro:', e.message);
    res.json({ hero: {}, sections: [] });
  }
});

// ═══════════════════════════════════════════════════════════
// FILMES
// ═══════════════════════════════════════════════════════════
router.get('/movies', async (req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    const movies = Array.isArray(organized?.byType?.movie) ? organized.byType.movie : [];
    res.json(paginate(movies, req.query.page, req.query.pageSize));
  } catch (e) {
    console.error('[movies] erro:', e.message);
    res.json({ page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] });
  }
});

router.get('/movies/hero', async (_req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    const movies = Array.isArray(organized?.byType?.movie) ? organized.byType.movie : [];
    const shuffled = [...movies].sort(() => 0.5 - Math.random());
    res.json({ items: shuffled.slice(0, 5) });
  } catch (e) {
    console.error('[movies/hero] erro:', e.message);
    res.json({ items: [] });
  }
});

router.get('/movies/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ error: 'parâmetro q obrigatório' });

    const organized = await iptv.getOrganizedList();
    const movies = Array.isArray(organized?.byType?.movie) ? organized.byType.movie : [];
    const items = movies.filter((m) => String(m?.name || '').toLowerCase().includes(q));
    res.json({ query: q, total: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('[movies/search] erro:', e.message);
    res.json({ query: req.query.q, total: 0, items: [] });
  }
});

router.get('/movies/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const organized = await iptv.getOrganizedList();
    const movies = Array.isArray(organized?.byType?.movie) ? organized.byType.movie : [];
    const item = movies.find((m) => String(m?.id) === id);

    if (!item) return res.status(404).json({ error: 'Filme não encontrado' });

    const enriched = await tmdb.complete(item).catch(() => item);
    let details = null;
    if (enriched?.tmdbId) {
      details = await tmdb.getMovieDetails(enriched.tmdbId).catch(() => null);
    }

    res.json({
      ...enriched,
      ...(details || {}),
      id: item.id,
      streamUrl: iptv.buildStreamUrl(item.id, 'movie'),
    });
  } catch (e) {
    console.error('[movies/:id] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SÉRIES
// ═══════════════════════════════════════════════════════════
router.get('/series', async (req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    const series = Array.isArray(organized?.byType?.tv) ? organized.byType.tv : [];
    res.json(paginate(series, req.query.page, req.query.pageSize));
  } catch (e) {
    console.error('[series] erro:', e.message);
    res.json({ page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] });
  }
});

router.get('/series/hero', async (_req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    const series = Array.isArray(organized?.byType?.tv) ? organized.byType.tv : [];
    const shuffled = [...series].sort(() => 0.5 - Math.random());
    res.json({ items: shuffled.slice(0, 5) });
  } catch (e) {
    console.error('[series/hero] erro:', e.message);
    res.json({ items: [] });
  }
});

router.get('/series/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ error: 'parâmetro q obrigatório' });

    const organized = await iptv.getOrganizedList();
    const series = Array.isArray(organized?.byType?.tv) ? organized.byType.tv : [];
    const items = series.filter((s) => String(s?.name || '').toLowerCase().includes(q));
    res.json({ query: q, total: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('[series/search] erro:', e.message);
    res.json({ query: req.query.q, total: 0, items: [] });
  }
});

router.get('/series/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const organized = await iptv.getOrganizedList();
    const series = Array.isArray(organized?.byType?.tv) ? organized.byType.tv : [];
    const item = series.find((s) => String(s?.id) === id);

    if (!item) return res.status(404).json({ error: 'Série não encontrada' });

    const enriched = await tmdb.complete(item).catch(() => item);
    let details = null;
    if (enriched?.tmdbId) {
      details = await tmdb.getSeriesDetails(enriched.tmdbId).catch(() => null);
    }

    res.json({
      ...enriched,
      ...(details || {}),
      id: item.id,
    });
  } catch (e) {
    console.error('[series/:id] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/series/:id/season/:num', async (req, res) => {
  try {
    const id = String(req.params.id);
    const num = parseInt(req.params.num, 10);

    const organized = await iptv.getOrganizedList();
    const series = Array.isArray(organized?.byType?.tv) ? organized.byType.tv : [];
    const item = series.find((s) => String(s?.id) === id);
    if (!item) return res.status(404).json({ error: 'Série não encontrada' });

    const enriched = await tmdb.complete(item).catch(() => item);
    let season = null;
    if (enriched?.tmdbId) {
      season = await tmdb.getSeason(enriched.tmdbId, num).catch(() => null);
    }

    // Busca episódios na IPTV
    let iptvEpisodes = [];
    try {
      const info = await iptv.getSeriesInfo(id);
      const epMap = info?.episodes || {};
      const seasonKey = String(num);
      iptvEpisodes = Array.isArray(epMap?.[seasonKey]) ? epMap[seasonKey] : [];
    } catch (_) {}

    // Merge por número
    const episodes = Array.isArray(season?.episodes)
      ? season.episodes.map((ep) => {
          const iptvEp = iptvEpisodes.find(
            (x) => String(x?.episode_num) === String(ep?.number)
          );
          return {
            ...ep,
            streamUrl: iptvEp
              ? iptv.buildStreamUrl(
                  iptvEp.id || iptvEp.stream_id,
                  'series'
                )
              : null,
            iptvId: iptvEp?.id || null,
          };
        })
      : [];

    res.json({
      seriesId: id,
      tmdbId: enriched?.tmdbId || null,
      seasonNumber: num,
      title: season?.title || `Temporada ${num}`,
      overview: season?.overview || '',
      cover: season?.cover || '',
      airDate: season?.airDate || '',
      episodes,
    });
  } catch (e) {
    console.error('[series/:id/season/:num] erro:', e.message);
    res.json({
      seriesId: req.params.id,
      seasonNumber: parseInt(req.params.num, 10),
      title: '',
      overview: '',
      cover: '',
      airDate: '',
      episodes: [],
    });
  }
});

// ═══════════════════════════════════════════════════════════
// CANAIS
// ═══════════════════════════════════════════════════════════
router.get('/channels', async (req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    const channels = Array.isArray(organized?.byType?.channel) ? organized.byType.channel : [];
    res.json(paginate(channels, req.query.page, req.query.pageSize));
  } catch (e) {
    console.error('[channels] erro:', e.message);
    res.json({ page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] });
  }
});

// ═══════════════════════════════════════════════════════════
// CATEGORIAS
// ═══════════════════════════════════════════════════════════
router.get('/categories', async (_req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    const byCategory = organized?.byCategory || {};
    const categories = Object.entries(byCategory)
      .map(([name, items]) => {
        const safeItems = Array.isArray(items) ? items : [];
        const type = safeItems[0]?.type || 'other';
        return { name, count: safeItems.length, type };
      })
      .sort((a, b) => b.count - a.count);

    res.json({ total: categories.length, categories });
  } catch (e) {
    console.error('[categories] erro:', e.message);
    res.json({ total: 0, categories: [] });
  }
});

router.get('/categories/:name', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const organized = await iptv.getOrganizedList();
    const byCategory = organized?.byCategory || {};
    const items = Array.isArray(byCategory[name]) ? byCategory[name] : [];
    res.json(paginate(items, req.query.page, req.query.pageSize));
  } catch (e) {
    console.error('[categories/:name] erro:', e.message);
    res.json({ page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] });
  }
});

// ═══════════════════════════════════════════════════════════
// STREAM
// ═══════════════════════════════════════════════════════════
router.get('/stream/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const type = String(req.query.type || 'live');
    const url = iptv.buildStreamUrl(id, type);
    res.json({ id, type, url });
  } catch (e) {
    console.error('[stream/:id] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// REFRESH CACHE
// ═══════════════════════════════════════════════════════════
router.get('/admin/refresh-cache', async (_req, res) => {
  try {
    cache.clear();
    const organized = await iptv.getOrganizedList();
    res.json({
      ok: true,
      message: 'Cache limpo e recarregado',
      total: organized?.total || 0,
      counts: organized?.counts || {},
      categories: Array.isArray(organized?.categories) ? organized.categories.length : 0,
    });
  } catch (e) {
    console.error('[refresh-cache] erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/refresh-cache', async (_req, res) => {
  try {
    cache.clear();
    const organized = await iptv.getOrganizedList();
    res.json({
      ok: true,
      total: organized?.total || 0,
      counts: organized?.counts || {},
      categories: Array.isArray(organized?.categories) ? organized.categories.length : 0,
    });
  } catch (e) {
    console.error('[refresh-cache] erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ROTAS DE DEBUG (temporárias — remover depois)
// ═══════════════════════════════════════════════════════════

// 1. Testa se a IPTV responde
router.get('/debug/iptv-raw', async (_req, res) => {
  try {
    const axios = require('axios');
    const url = process.env.IPTV_BASE_URL;
    const user = process.env.IPTV_USERNAME;
    const pass = process.env.IPTV_PASSWORD;

    if (!url || !user || !pass) {
      return res.json({
        ok: false,
        error: 'Credenciais IPTV faltando no .env',
        env: {
          url: url ? '✅' : '❌',
          user: user ? '✅' : '❌',
          pass: pass ? '✅' : '❌',
        },
      });
    }

    const testUrl = `${url}/player_api.php?username=${user}&password=${pass}`;
    const testRes = await axios.get(testUrl, { timeout: 15000 });

    res.json({
      ok: true,
      statusConexao: testRes.status,
      resposta: testRes.data,
      urlUsada: testUrl.replace(pass, '***'),
    });
  } catch (e) {
    res.json({
      ok: false,
      error: e.message,
      code: e.code,
      urlTentada: e.config?.url?.replace(process.env.IPTV_PASSWORD, '***'),
    });
  }
});

// 2. Testa o get_vod_streams (filmes)
router.get('/debug/iptv-movies', async (_req, res) => {
  try {
    const axios = require('axios');
    const url = process.env.IPTV_BASE_URL;
    const user = process.env.IPTV_USERNAME;
    const pass = process.env.IPTV_PASSWORD;

    const apiUrl = `${url}/player_api.php?username=${user}&password=${pass}&action=get_vod_streams`;
    const { data } = await axios.get(apiUrl, { timeout: 30000 });

    res.json({
      ok: true,
      tipo: Array.isArray(data) ? 'array' : typeof data,
      total: Array.isArray(data) ? data.length : 0,
      primeiros3: Array.isArray(data) ? data.slice(0, 3) : data,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 3. Testa o get_series
router.get('/debug/iptv-series', async (_req, res) => {
  try {
    const axios = require('axios');
    const url = process.env.IPTV_BASE_URL;
    const user = process.env.IPTV_USERNAME;
    const pass = process.env.IPTV_PASSWORD;

    const apiUrl = `${url}/player_api.php?username=${user}&password=${pass}&action=get_series`;
    const { data } = await axios.get(apiUrl, { timeout: 30000 });

    res.json({
      ok: true,
      tipo: Array.isArray(data) ? 'array' : typeof data,
      total: Array.isArray(data) ? data.length : 0,
      primeiros3: Array.isArray(data) ? data.slice(0, 3) : data,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 4. Testa as categorias
router.get('/debug/iptv-categories', async (_req, res) => {
  try {
    const axios = require('axios');
    const url = process.env.IPTV_BASE_URL;
    const user = process.env.IPTV_USERNAME;
    const pass = process.env.IPTV_PASSWORD;

    const actions = ['get_vod_categories', 'get_series_categories', 'get_live_categories'];
    const results = {};

    for (const action of actions) {
      try {
        const apiUrl = `${url}/player_api.php?username=${user}&password=${pass}&action=${action}`;
        const { data } = await axios.get(apiUrl, { timeout: 15000 });
        results[action] = {
          tipo: Array.isArray(data) ? 'array' : typeof data,
          total: Array.isArray(data) ? data.length : 0,
          primeiros5: Array.isArray(data) ? data.slice(0, 5) : data,
        };
      } catch (e) {
        results[action] = { error: e.message };
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 5. Mostra o resultado do getOrganizedList
router.get('/debug/organized', async (_req, res) => {
  try {
    const organized = await iptv.getOrganizedList();
    res.json({
      ok: true,
      total: organized?.total,
      counts: organized?.counts,
      categorias: Array.isArray(organized?.categories) ? organized.categories.length : 0,
      primeirasCategorias: Array.isArray(organized?.categories) 
        ? organized.categories.slice(0, 10) 
        : [],
      primeirosFilmes: Array.isArray(organized?.byType?.movie)
        ? organized.byType.movie.slice(0, 3)
        : [],
      primeirasSeries: Array.isArray(organized?.byType?.tv)
        ? organized.byType.tv.slice(0, 3)
        : [],
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, stack: e.stack });
  }
});

// 6. Verifica variáveis do .env
router.get('/debug/env', (_req, res) => {
  res.json({
    IPTV_BASE_URL: process.env.IPTV_BASE_URL 
      ? process.env.IPTV_BASE_URL.replace(/(:\/\/)(.*)/, '$1' + '***') 
      : '❌ FALTANDO',
    IPTV_USERNAME: process.env.IPTV_USERNAME ? '✅ ' + process.env.IPTV_USERNAME.slice(0, 3) + '***' : '❌ FALTANDO',
    IPTV_PASSWORD: process.env.IPTV_PASSWORD ? '✅ configurado' : '❌ FALTANDO',
    TMDB_API_KEY: process.env.TMDB_API_KEY ? '✅ configurado' : '❌ FALTANDO',
    TMDB_LANGUAGE: process.env.TMDB_LANGUAGE || '❌ FALTANDO',
  });
});

module.exports = router;