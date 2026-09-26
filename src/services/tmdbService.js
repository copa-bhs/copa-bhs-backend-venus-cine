/**
 * Serviço TMDB.
 * REGRA: IPTV é prioridade. TMDB só completa o que falta.
 */
const axios = require('axios');
const cache = require('./cacheService');
const { cleanTitle, extractYear } = require('./iptvService');

const BASE = 'https://api.themoviedb.org/3';

function getKey() {
  return process.env.TMDB_API_KEY;
}

function isConfigured() {
  return Boolean(getKey());
}

function getLang() {
  return process.env.TMDB_LANGUAGE || 'pt-BR';
}

function getCacheTtl() {
  return parseInt(process.env.TMDB_CACHE_TTL || '86400', 10);
}

function img(path, size = 'w500') {
  if (!path) return '';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

async function getBestLogo(tmdbId, type) {
  if (!isConfigured() || !tmdbId) return '';
  const key = `tmdb:logo:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached !== null) return cached;

  try {
    const data = await tmdbFetch(`/${type}/${tmdbId}/images`, {
      include_image_language: 'pt,en,null',
    });

    const rawLogos = Array.isArray(data?.logos) ? data.logos : [];
    if (rawLogos.length === 0) {
      cache.set(key, '', getCacheTtl());
      return '';
    }

    const valid = rawLogos.filter((l) => {
      const fp = String(l?.file_path || '').toLowerCase();
      if (!fp.endsWith('.png') && !fp.endsWith('.svg')) return false;
      const w = Number(l?.width || 0);
      const h = Number(l?.height || 0);
      if (w === 0 || h === 0) return false;
      const ratio = w / h;
      if (ratio < 2) return false;
      return true;
    });

    console.log(`[tmdb:logo] ${type}/${tmdbId}: ${rawLogos.length} logos → ${valid.length} válidos`);

    if (valid.length === 0) {
      cache.set(key, '', getCacheTtl());
      return '';
    }

    const priority = (lang) => (lang === 'pt' ? 0 : lang === 'en' ? 1 : 2);
    valid.sort((a, b) => {
      const pa = priority(a?.iso_639_1);
      const pb = priority(b?.iso_639_1);
      if (pa !== pb) return pa - pb;
      return (b?.vote_average || 0) - (a?.vote_average || 0);
    });

    const best = valid[0];
    const url = img(best.file_path, 'w500');

    console.log(`[tmdb:logo] ${type}/${tmdbId} → escolhido:`, {
      file: best.file_path,
      lang: best.iso_639_1,
      size: `${best.width}x${best.height}`,
      ratio: (best.width / best.height).toFixed(2),
    });

    cache.set(key, url, getCacheTtl());
    return url;
  } catch (e) {
    console.warn('[tmdb] getBestLogo falhou:', e.message);
    return '';
  }
}

async function getBestBackdrop(tmdbId, type) {
  if (!isConfigured() || !tmdbId) return '';
  const key = `tmdb:backdrop:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached !== null) return cached;

  try {
    const data = await tmdbFetch(`/${type}/${tmdbId}/images`);
    const backdrops = Array.isArray(data?.backdrops) ? data.backdrops : [];
    if (backdrops.length === 0) {
      cache.set(key, '', getCacheTtl());
      return '';
    }

    const sorted = [...backdrops].sort(
      (a, b) => (b?.vote_average || 0) - (a?.vote_average || 0)
    );
    const best = sorted[0];
    const url = best?.file_path ? img(best.file_path, 'w1280') : '';
    cache.set(key, url, getCacheTtl());
    return url;
  } catch (e) {
    console.warn('[tmdb] getBestBackdrop falhou:', e.message);
    return '';
  }
}

async function getImages(tmdbId, type) {
  if (!isConfigured() || !tmdbId) {
    return { posters: [], backdrops: [], logos: [] };
  }
  const key = `tmdb:images:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const data = await tmdbFetch(`/${type}/${tmdbId}/images`, {
      include_image_language: 'pt,en,null',
    });

    const mapImg = (arr, size) =>
      Array.isArray(arr)
        ? arr.slice(0, 10).map((i) => ({
            url: img(i.file_path, size),
            original: img(i.file_path, 'original'),
            width: i.width || 0,
            height: i.height || 0,
            language: i.iso_639_1 || null,
            rating: i.vote_average ? Number(i.vote_average.toFixed(1)) : 0,
          }))
        : [];

    const result = {
      posters: mapImg(data?.posters, 'w500'),
      backdrops: mapImg(data?.backdrops, 'w1280'),
      logos: mapImg(data?.logos, 'w500'),
    };

    cache.set(key, result, getCacheTtl());
    return result;
  } catch (e) {
    console.warn('[tmdb] getImages falhou:', e.message);
    return { posters: [], backdrops: [], logos: [] };
  }
}

async function tmdbFetch(path, params = {}) {
  if (!isConfigured()) return null;
  const { data } = await axios.get(`${BASE}${path}`, {
    params: { api_key: getKey(), language: getLang(), ...params },
    timeout: 12000,
  });
  return data;
}

// ─── Busca ───
async function searchTMDB(query, year, type = 'multi') {
  if (!isConfigured() || !query) return [];
  const key = `tmdb:search:${type}:${query}:${year || ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const params = { query, include_adult: false };
    if (year) params.year = year;
    const data = await tmdbFetch(`/search/${type}`, params);
    const results = Array.isArray(data?.results)
      ? data.results.filter((r) => r?.media_type !== 'person').slice(0, 5)
      : [];
    cache.set(key, results, getCacheTtl());
    return results;
  } catch (e) {
    console.warn('[tmdb] busca falhou:', e.message);
    return [];
  }
}

// ─── Completa o que falta ───
async function complete(iptvItem) {
  if (!isConfigured()) {
    return { ...iptvItem, _tmdb: { used: false, reason: 'not_configured' } };
  }
  if (!iptvItem || typeof iptvItem !== 'object') return iptvItem;

  const needsTMDB =
    !iptvItem.cover || !iptvItem.backdrop || !iptvItem.overview || !iptvItem.year;

  if (!needsTMDB) {
    return { ...iptvItem, _tmdb: { used: false, reason: 'iptv_complete' } };
  }

  const clean = cleanTitle(iptvItem.name || '');
  const year = iptvItem.year || extractYear(iptvItem.name || '');
  if (!clean) return { ...iptvItem, _tmdb: { used: false, reason: 'no_title' } };

  const results = await searchTMDB(clean, year, 'multi');
  if (!Array.isArray(results) || results.length === 0) {
    return { ...iptvItem, _tmdb: { used: false, reason: 'not_found' } };
  }

  const best = results[0];
  const type = best?.media_type || (best?.title ? 'movie' : 'tv');

  return {
    ...iptvItem,
    title: iptvItem.title || best?.title || best?.name || iptvItem.name,
    cover: iptvItem.cover || img(best?.poster_path, 'w500'),
    backdrop: iptvItem.backdrop || img(best?.backdrop_path, 'w1280'),
    overview: iptvItem.overview || best?.overview || '',
    year:
      iptvItem.year ||
      (best?.release_date || best?.first_air_date || '').slice(0, 4) ||
      null,
    rating: best?.vote_average ? Number(best.vote_average.toFixed(1)) : null,
    genres: Array.isArray(best?.genre_ids) ? best.genre_ids.slice(0, 3) : [],
    tmdbId: best?.id || null,
    tmdbType: type,
    _tmdb: {
      used: true,
      sources: {
        cover: iptvItem.cover ? 'iptv' : 'tmdb',
        backdrop: iptvItem.backdrop ? 'iptv' : 'tmdb',
        overview: iptvItem.overview ? 'iptv' : 'tmdb',
        year: iptvItem.year ? 'iptv' : 'tmdb',
      },
    },
  };
}

// ─── Trending ───
async function getTrending(type = 'all', window = 'week') {
  if (!isConfigured()) return [];
  const key = `tmdb:trending:${type}:${window}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const data = await tmdbFetch(`/trending/${type}/${window}`);
    const list = Array.isArray(data?.results)
      ? data.results.slice(0, 20).map((r) => ({
          tmdbId: r?.id,
          type: r?.media_type || (r?.title ? 'movie' : 'tv'),
          title: r?.title || r?.name || '',
          overview: r?.overview || '',
          cover: img(r?.poster_path, 'w500'),
          backdrop: img(r?.backdrop_path, 'w1280'),
          rating: r?.vote_average ? Number(r.vote_average.toFixed(1)) : null,
          year: (r?.release_date || r?.first_air_date || '').slice(0, 4),
        }))
      : [];
    cache.set(key, list, getCacheTtl());
    return list;
  } catch (e) {
    console.warn('[tmdb] trending falhou:', e.message);
    return [];
  }
}

// ─── Detalhes de filme ───
async function getMovieDetails(tmdbId) {
  if (!isConfigured() || !tmdbId) return null;
  const key = `tmdb:movie:${tmdbId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const data = await tmdbFetch(`/movie/${tmdbId}`, {
      append_to_response: 'videos,credits,similar',
    });
    if (!data) return null;

    const trailerVideo = Array.isArray(data?.videos?.results)
      ? data.videos.results.find((v) => v?.type === 'Trailer' && v?.site === 'YouTube')
      : null;

    const result = {
      tmdbId: data.id,
      type: 'movie',
      title: data.title || data.name || '',
      overview: data.overview || '',
      cover: img(data.poster_path, 'w500'),
      backdrop: img(data.backdrop_path, 'w1280'),
      rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
      runtime: data.runtime || null,
      genres: Array.isArray(data.genres) ? data.genres.map((g) => g?.name).filter(Boolean) : [],
      releaseDate: data.release_date || '',
      trailer: trailerVideo ? `https://www.youtube.com/watch?v=${trailerVideo.key}` : null,
      cast: Array.isArray(data?.credits?.cast)
        ? data.credits.cast.slice(0, 10).map((c) => ({
            name: c?.name || '',
            character: c?.character || '',
            photo: img(c?.profile_path, 'w185'),
          }))
        : [],
      similar: Array.isArray(data?.similar?.results)
        ? data.similar.results.slice(0, 12).map((s) => ({
            tmdbId: s?.id,
            title: s?.title || s?.name || '',
            cover: img(s?.poster_path, 'w342'),
            year: (s?.release_date || s?.first_air_date || '').slice(0, 4),
          }))
        : [],
    };

    const [logo, images] = await Promise.all([
      getBestLogo(tmdbId, 'movie').catch(() => ''),
      getImages(tmdbId, 'movie').catch(() => ({ posters: [], backdrops: [], logos: [] })),
    ]);
    result.logo = logo;
    result.allPosters = images.posters;
    result.allBackdrops = images.backdrops;
    result.allLogos = images.logos;

    cache.set(key, result, getCacheTtl());
    return result;
  } catch (e) {
    console.warn('[tmdb] movie details falhou:', e.message);
    return null;
  }
}

// ─── Detalhes de série ───
async function getSeriesDetails(tmdbId) {
  if (!isConfigured() || !tmdbId) return null;
  const key = `tmdb:tv:${tmdbId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const data = await tmdbFetch(`/tv/${tmdbId}`, {
      append_to_response: 'videos,credits,similar',
    });
    if (!data) return null;

    const trailerVideo = Array.isArray(data?.videos?.results)
      ? data.videos.results.find((v) => v?.type === 'Trailer' && v?.site === 'YouTube')
      : null;

    const result = {
      tmdbId: data.id,
      type: 'tv',
      title: data.name || data.title || '',
      overview: data.overview || '',
      cover: img(data.poster_path, 'w500'),
      backdrop: img(data.backdrop_path, 'w1280'),
      rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
      genres: Array.isArray(data.genres) ? data.genres.map((g) => g?.name).filter(Boolean) : [],
      releaseDate: data.first_air_date || '',
      trailer: trailerVideo ? `https://www.youtube.com/watch?v=${trailerVideo.key}` : null,
      cast: Array.isArray(data?.credits?.cast)
        ? data.credits.cast.slice(0, 10).map((c) => ({
            name: c?.name || '',
            character: c?.character || '',
            photo: img(c?.profile_path, 'w185'),
          }))
        : [],
      similar: Array.isArray(data?.similar?.results)
        ? data.similar.results.slice(0, 12).map((s) => ({
            tmdbId: s?.id,
            title: s?.title || s?.name || '',
            cover: img(s?.poster_path, 'w342'),
            year: (s?.release_date || s?.first_air_date || '').slice(0, 4),
          }))
        : [],
      seasons: Array.isArray(data?.seasons)
        ? data.seasons
            .filter((s) => s?.season_number > 0)
            .map((s) => ({
              number: s.season_number,
              title: s.name || `Temporada ${s.season_number}`,
              episodeCount: s.episode_count || 0,
              cover: img(s.poster_path, 'w500'),
              year: (s.air_date || '').slice(0, 4),
            }))
        : [],
    };

    const [logo, images] = await Promise.all([
      getBestLogo(tmdbId, 'tv').catch(() => ''),
      getImages(tmdbId, 'tv').catch(() => ({ posters: [], backdrops: [], logos: [] })),
    ]);
    result.logo = logo;
    result.allPosters = images.posters;
    result.allBackdrops = images.backdrops;
    result.allLogos = images.logos;

    cache.set(key, result, getCacheTtl());
    return result;
  } catch (e) {
    console.warn('[tmdb] tv details falhou:', e.message);
    return null;
  }
}

// ─── Temporada + episódios ───
async function getSeason(tmdbId, seasonNumber) {
  if (!isConfigured() || !tmdbId) return null;
  const key = `tmdb:season:${tmdbId}:${seasonNumber}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`);
    if (!data) return null;

    const result = {
      title: data.name || `Temporada ${seasonNumber}`,
      overview: data.overview || '',
      cover: img(data.poster_path, 'w500'),
      airDate: data.air_date || '',
      episodes: Array.isArray(data.episodes)
        ? data.episodes.map((ep) => ({
            number: ep?.episode_number || 0,
            title: ep?.name || '',
            overview: ep?.overview || '',
            cover: img(ep?.still_path, 'w300'),
            rating: ep?.vote_average ? Number(ep.vote_average.toFixed(1)) : null,
            runtime: ep?.runtime || null,
            airDate: ep?.air_date || '',
          }))
        : [],
    };

    cache.set(key, result, getCacheTtl());
    return result;
  } catch (e) {
    console.warn('[tmdb] season falhou:', e.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  complete,
  getTrending,
  getMovieDetails,
  getSeriesDetails,
  getSeason,
  img,
  getBestLogo,
  getBestBackdrop,
  getImages,
};