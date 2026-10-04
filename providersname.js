/* ============================================================================
 *  Provider Lookup API — TMDB ID → OTT providers (via TMDB + JustWatch)
 *  ---------------------------------------------------------------------------
 *  Flow:
 *    1. TMDB /movie/:id or /tv/:id  →  get canonical title
 *    2. JustWatch ?q=<title>        →  search by TITLE (not ID)
 *    3. Match returned entries by tmdbId field
 *    4. Extract providers from the matched entry's offers[]
 *
 *  Endpoints:
 *    GET /providers/movie/:tmdbId
 *    GET /providers/tv/:tmdbId
 *    GET /providers/:tmdbId?type=movie|tv
 *    GET /providers/movie/:tmdbId?full=1   (include raw JW entries)
 *    GET /health
 * ==========================================================================*/

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/*  .env loader                                                               */
/* -------------------------------------------------------------------------- */

const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)));

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return false;
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return false; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (!/^["']/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash);
    }
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

const envPath = join(rootDir, '.env');
const envLoaded = loadDotEnv(envPath);

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const PORT              = Number(process.env.PORT_PROVIDER || 4000);
const HOST              = process.env.HOST || '0.0.0.0';

const JUSTWATCH_API     = (process.env.JUSTWATCH_API || 'https://imdb.iamidiotareyoutoo.com').replace(/\/+$/, '');
const JW_COUNTRY        = (process.env.JW_COUNTRY || 'IN').toUpperCase();
const JW_LANG           = (process.env.JW_LANG || 'en').toLowerCase();

const TMDB_PROXY        = (process.env.TMDB_PROXY || '').replace(/\/+$/, '');
const TMDB_API_KEY      = (process.env.TMDB_API_KEY || '').trim();

const FETCH_TIMEOUT_MS  = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const CACHE_TTL_MS      = Number(process.env.CACHE_TTL_MS || 3600) * 1000;
const NEG_CACHE_TTL_MS  = Number(process.env.NEG_CACHE_TTL_MS || 300) * 1000;
const RETRIES           = Number(process.env.RETRIES || 4);
const RETRY_BASE_MS     = Number(process.env.RETRY_BASE_MS || 350);
const LOG_LEVEL         = (process.env.LOG_LEVEL || 'info').toLowerCase();

const UPSTREAM_UA = process.env.UPSTREAM_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/* -------------------------------------------------------------------------- */
/*  Logger                                                                    */
/* -------------------------------------------------------------------------- */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const level = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(lvl, msg, meta) {
  if (LEVELS[lvl] > level) return;
  const ts = new Date().toISOString();
  const tag = lvl.toUpperCase().padEnd(5);
  console.log(meta ? `${ts} ${tag} ${msg} ${JSON.stringify(meta)}` : `${ts} ${tag} ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/*  HTTP helpers                                                              */
/* -------------------------------------------------------------------------- */

function send(res, status, body, contentType = 'application/json; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function sendJson(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8', extra);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      headers: { 'User-Agent': UPSTREAM_UA, 'Accept': '*/*', ...(options.headers || {}) },
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}, label = 'fetch') {
  let lastErr;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const res = await fetchWithTimeout(url, options);
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error(`${label} HTTP ${res.status}`);
      log('warn', 'retrying', { label, attempt: i + 1, status: res.status });
    } catch (err) {
      lastErr = err;
      log('warn', 'retrying', { label, attempt: i + 1, err: err.message });
    }
    if (i < RETRIES - 1) await sleep(RETRY_BASE_MS * Math.pow(2, i));
  }
  throw lastErr || new Error(`${label} failed`);
}

/* -------------------------------------------------------------------------- */
/*  Cache                                                                     */
/* -------------------------------------------------------------------------- */

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  if (cache.size > 5000) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, { value, ts: Date.now(), ttl });
}

/* -------------------------------------------------------------------------- */
/*  TMDB — resolve tmdbId → title                                             */
/* -------------------------------------------------------------------------- */

async function fetchTmdbTitle(tmdbId, type) {
  const cacheKey = `tmdb:${type}:${tmdbId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (!TMDB_PROXY && !TMDB_API_KEY) {
    throw new Error('TMDB_PROXY or TMDB_API_KEY must be set in .env');
  }

  const endpoint = type === 'movie' ? 'movie' : 'tv';
  const url = TMDB_PROXY
    ? `${TMDB_PROXY}/${endpoint}/${tmdbId}`
    : `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;

  const res = await fetchWithRetry(url, { headers: { Referer: url } }, `tmdb ${endpoint}/${tmdbId}`);
  if (!res.ok) throw new Error(`TMDB ${endpoint}/${tmdbId} HTTP ${res.status}`);

  const data = await res.json();
  const title = type === 'movie'
    ? (data.title || data.original_title)
    : (data.name || data.original_name);
  if (!title) throw new Error(`TMDB returned no title for ${type}/${tmdbId}`);

  const result = {
    title: String(title).trim(),
    originalTitle: String(data.original_title || data.original_name || '').trim(),
    year: Number((data.release_date || data.first_air_date || '').slice(0, 4)) || null,
  };
  cacheSet(cacheKey, result, CACHE_TTL_MS);
  return result;
}

/* -------------------------------------------------------------------------- */
/*  JustWatch                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Search JustWatch by TITLE TEXT (not by TMDB ID — that never works).
 * Returns raw entries array.
 */
async function justwatchSearch(query) {
  const url = `${JUSTWATCH_API}/justwatch?q=${encodeURIComponent(query)}&L=${JW_LANG}_${JW_COUNTRY}`;
  log('debug', 'justwatch query', { url });

  const res = await fetchWithRetry(url, { headers: { Accept: '*/*' } }, 'justwatch');
  if (!res.ok) throw new Error(`JustWatch HTTP ${res.status}`);

  const json = await res.json();
  return Array.isArray(json?.description) ? json.description : [];
}

/**
 * Match an entry by TMDB ID. JustWatch returns the tmdbId inside each entry,
 * so this is a reliable match. Falls back to type+title if TMDB ID absent.
 */
function matchTmdbEntry(entries, tmdbId, type, title) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // 1. Exact tmdbId match
  const byId = entries.find(e => String(e.tmdbId) === String(tmdbId));
  if (byId) return byId;

  // 2. Exact type + title match
  const wantType = type === 'tv' ? 'SHOW' : 'MOVIE';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wantTitle = norm(title);
  const byTitle = entries.find(e =>
    String(e.type).toUpperCase() === wantType && norm(e.title) === wantTitle
  );
  if (byTitle) return byTitle;

  // 3. Type + startsWith title
  const byPrefix = entries.find(e =>
    String(e.type).toUpperCase() === wantType &&
    (norm(e.title).startsWith(wantTitle) || wantTitle.startsWith(norm(e.title)))
  );
  if (byPrefix) return byPrefix;

  // 4. Only one entry of the right type → use it
  const typed = entries.filter(e => String(e.type).toUpperCase() === wantType);
  if (typed.length === 1) return typed[0];

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Provider extraction                                                       */
/* -------------------------------------------------------------------------- */

function extractProviders(jwEntry) {
  if (!jwEntry || !Array.isArray(jwEntry.offers)) return [];

  const map = new Map();
  for (const offer of jwEntry.offers) {
    const name = String(offer.name || '').trim();
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, types: new Set(), urls: new Set() });
    const e = map.get(name);
    if (offer.type) e.types.add(String(offer.type).trim());
    if (offer.url)  e.urls.add(offer.url);
  }

  return [...map.values()].map(v => ({
    name: v.name,
    types: [...v.types],
    urls: [...v.urls],
  }));
}

function classifyProviders(providers) {
  const buckets = { flatrate: [], rent: [], buy: [], ads: [], free: [], other: [] };
  for (const p of providers) {
    const types = p.types.map(t => t.toUpperCase());
    let placed = false;
    if (types.some(t => t.includes('FLATRATE'))) { buckets.flatrate.push(p); placed = true; }
    if (types.some(t => t.includes('RENT')))     buckets.rent.push(p);
    if (types.some(t => t.includes('BUY')))      buckets.buy.push(p);
    if (types.some(t => t.includes('ADS')))      buckets.ads.push(p);
    if (types.some(t => t.includes('FREE')))     buckets.free.push(p);
    if (!placed) buckets.other.push(p);
  }
  return buckets;
}

/* -------------------------------------------------------------------------- */
/*  Core lookup                                                               */
/* -------------------------------------------------------------------------- */

async function lookupProviders(tmdbId, type) {
  const key = `${type}:${tmdbId}:${JW_COUNTRY}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  // Step 1 — TMDB title
  const { title, year: tmdbYear } = await fetchTmdbTitle(tmdbId, type);
  log('info', 'tmdb resolved', { tmdbId, type, title });

  // Step 2 — JustWatch search by title
  let entries = await justwatchSearch(title);
  log('debug', 'justwatch results', { title, count: entries.length });

  // Retry with original title if nothing and it differs
  if (entries.length === 0) {
    const alt = await fetchTmdbTitle(tmdbId, type).then(r => r.originalTitle).catch(() => '');
    if (alt && alt !== title) {
      entries = await justwatchSearch(alt);
      log('debug', 'justwatch retry (original title)', { alt, count: entries.length });
    }
  }

  // Step 3 — match by tmdbId (JustWatch includes tmdbId in each entry)
  const match = matchTmdbEntry(entries, tmdbId, type, title);

  if (!match) {
    const empty = {
      ok: true,
      tmdbId: String(tmdbId),
      type,
      matched: false,
      searchedTitle: title,
      tmdbYear,
      title: null,
      year: null,
      providerNames: [],
      providers: [],
      buckets: { flatrate: [], rent: [], buy: [], ads: [], free: [], other: [] },
      count: 0,
      note: entries.length === 0
        ? `No JustWatch results for title "${title}"`
        : `JustWatch returned ${entries.length} results but none matched tmdbId ${tmdbId}`,
    };
    cacheSet(key, empty, NEG_CACHE_TTL_MS);
    return { ...empty, cached: false };
  }

  const providers = extractProviders(match);
  const buckets = classifyProviders(providers);

  const result = {
    ok: true,
    tmdbId: String(tmdbId),
    type,
    matched: true,
    searchedTitle: title,
    tmdbYear,
    title: match.title || null,
    year: match.year || null,
    jwType: match.type || null,
    jwUrl: match.url || null,
    imdbId: match.imdbId || null,
    poster: Array.isArray(match.photo_url) ? match.photo_url[0] : null,
    backdrop: Array.isArray(match.backdrops) ? match.backdrops[0] : null,
    providerNames: providers.map(p => p.name),
    providers,
    buckets,
    count: providers.length,
  };

  cacheSet(key, result, CACHE_TTL_MS);
  return { ...result, cached: false };
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

function parseType(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase();
  if (t === 'movie' || t === 'film') return 'movie';
  if (t === 'tv' || t === 'show' || t === 'series') return 'tv';
  return null;
}

async function handle(req, res) {
  const reqId = randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', reqId);

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
    return;
  }

  if (path === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'provider-lookup',
      envLoaded,
      cacheSize: cache.size,
      country: JW_COUNTRY,
      lang: JW_LANG,
      justwatch: JUSTWATCH_API,
      tmdb: TMDB_PROXY ? `proxy ${TMDB_PROXY}` : (TMDB_API_KEY ? 'api.themoviedb.org' : 'MISSING'),
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  // /providers/movie/:id  |  /providers/tv/:id
  const typedMatch = path.match(/^\/providers\/(movie|tv|show|series|film)\/(\d+)\/?$/i);
  if (typedMatch) {
    const type = parseType(typedMatch[1]);
    const tmdbId = typedMatch[2];
    const full = url.searchParams.get('full') === '1';
    try {
      const data = await lookupProviders(tmdbId, type);
      const out = full ? { ...data, raw: await justwatchSearch(data.searchedTitle || tmdbId) } : data;
      sendJson(res, 200, out, {
        'Cache-Control': data.cached ? `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}` : 'no-store',
      });
    } catch (err) {
      log('error', 'lookup failed', { reqId, tmdbId, type, err: err.message });
      sendJson(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  // /providers/:id?type=movie|tv
  const idMatch = path.match(/^\/providers\/(\d+)\/?$/i);
  if (idMatch) {
    const tmdbId = idMatch[1];
    const type = parseType(url.searchParams.get('type')) || 'movie';
    const full = url.searchParams.get('full') === '1';
    try {
      const data = await lookupProviders(tmdbId, type);
      const out = full ? { ...data, raw: await justwatchSearch(data.searchedTitle || tmdbId) } : data;
      sendJson(res, 200, out, {
        'Cache-Control': data.cached ? `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}` : 'no-store',
      });
    } catch (err) {
      log('error', 'lookup failed', { reqId, tmdbId, type, err: err.message });
      sendJson(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  if (path === '/' || path === '') {
    sendJson(res, 200, {
      ok: true,
      service: 'provider-lookup',
      usage: {
        movie: 'GET /providers/movie/:tmdbId',
        tv:    'GET /providers/tv/:tmdbId',
        alt:   'GET /providers/:tmdbId?type=movie|tv',
        full:  'append ?full=1 to include raw JustWatch entries',
      },
      country: JW_COUNTRY,
      lang: JW_LANG,
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
}

/* -------------------------------------------------------------------------- */
/*  Server                                                                    */
/* -------------------------------------------------------------------------- */

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('error', 'handler crashed', { err: err.stack || err.message });
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
    else res.destroy();
  });
});

server.requestTimeout   = 30000;
server.headersTimeout   = 20000;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  log('info', 'provider-lookup listening', {
    url: `http://${HOST}:${PORT}`,
    env: envLoaded ? envPath : '(no .env)',
    justwatch: JUSTWATCH_API,
    country: JW_COUNTRY,
    lang: JW_LANG,
    tmdb: TMDB_PROXY ? `proxy ${TMDB_PROXY}` : (TMDB_API_KEY ? 'api.themoviedb.org' : 'MISSING'),
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown initiated', { signal });
  server.close((err) => {
    log(err ? 'error' : 'info', err ? 'close error' : 'closed cleanly', err ? { err: err.message } : {});
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => { log('warn', 'force exit'); process.exit(1); }, 5000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log('error', 'unhandledRejection', { reason: String(reason) }));
process.on('uncaughtException',  (err)    => { log('error', 'uncaughtException', { err: err.stack || err.message }); shutdown('uncaughtException'); });