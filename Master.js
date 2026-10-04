/* ============================================================================
 *  Master Routing Server — STRICT provider routing
 *  ---------------------------------------------------------------------------
 *  Flow:
 *    1. GET {PROVIDER_LOOKUP}/providers/{type}/{tmdbId}
 *    2. Decide routing from provider names:
 *         - Netflix only         → STRICT: [netflix]           (fail if it fails)
 *         - Amazon only          → STRICT: [amazon]            (fail if it fails)
 *         - Both                 → [netflix, amazon]           (prefer netflix)
 *         - Other OTT (Apple…)   → [netflix, amazon]           (try both)
 *         - None                 → [netflix, amazon]           (try both)
 *    3. Try each backend in order; first valid stream wins.
 *
 *  Strict mode is ON by default. Override per request with ?fallback=1
 *  to allow cross-backend fallback even in single-provider cases.
 *
 *  Endpoints:
 *    GET /movie/:tmdbId
 *    GET /tv/:tmdbId/:season/:episode
 *    GET /providers/movie/:tmdbId
 *    GET /providers/tv/:tmdbId
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

const PORT                 = Number(process.env.PORT_MASTER || 7000);
const HOST                 = process.env.HOST || '0.0.0.0';

const PROVIDER_LOOKUP_URL  = (process.env.PROVIDER_LOOKUP_URL  || 'http://localhost:4000').replace(/\/+$/, '');
const NETFLIX_BACKEND_URL  = (process.env.NETFLIX_BACKEND_URL  || 'http://localhost:3000').replace(/\/+$/, '');
const AMAZON_BACKEND_URL   = (process.env.AMAZON_BACKEND_URL   || 'http://localhost:5000').replace(/\/+$/, '');

const PROVIDER_TIMEOUT_MS  = Number(process.env.PROVIDER_TIMEOUT_MS || 15000);
const BACKEND_TIMEOUT_MS   = Number(process.env.BACKEND_TIMEOUT_MS  || 25000);

const CACHE_TTL_MS         = Number(process.env.CACHE_TTL_MS || 600) * 1000;
const LOG_LEVEL            = (process.env.LOG_LEVEL || 'info').toLowerCase();

/** Strict mode: never fall back to the other backend when exactly one
 *  of Netflix/Amazon is the indicated provider. Disable globally with
 *  STRICT_ROUTING=0, or per request with ?fallback=1. */
const STRICT_ROUTING       = process.env.STRICT_ROUTING !== '0';

/** Verify the resolved title from the backend roughly matches the expected
 *  title from the provider lookup. Rejects clearly-wrong matches. */
const VERIFY_TITLE         = process.env.VERIFY_TITLE !== '0';

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
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

/* -------------------------------------------------------------------------- */
/*  Provider lookup cache                                                     */
/* -------------------------------------------------------------------------- */

const providerCache = new Map();

function cacheGet(key) {
  const e = providerCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { providerCache.delete(key); return null; }
  return e.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  if (providerCache.size > 2000) {
    const first = providerCache.keys().next().value;
    providerCache.delete(first);
  }
  providerCache.set(key, { value, ts: Date.now(), ttl });
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — provider lookup                                                  */
/* -------------------------------------------------------------------------- */

async function fetchProviders(type, tmdbId) {
  const cacheKey = `${type}:${tmdbId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const url = `${PROVIDER_LOOKUP_URL}/providers/${type}/${tmdbId}`;
  log('debug', 'provider lookup', { url });

  const res = await fetchWithTimeout(url, {}, PROVIDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Provider lookup HTTP ${res.status}`);

  const json = await res.json();
  const providerNames = Array.isArray(json?.providerNames) ? json.providerNames : [];

  const result = {
    providerNames,
    matched: Boolean(json?.matched),
    title: json?.title || null,
    year: json?.year || null,
  };
  cacheSet(cacheKey, result, CACHE_TTL_MS);
  return { ...result, cached: false };
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — routing decision (STRICT)                                        */
/* -------------------------------------------------------------------------- */

function buildRouting(providerNames, { allowFallback = false } = {}) {
  const lower = (providerNames || []).map(n => String(n).toLowerCase());

  const hasNetflix = lower.some(n => n.includes('netflix'));
  const hasAmazon  = lower.some(n => n.includes('amazon') || n.includes('prime'));

  // --- Exactly one of Netflix / Amazon → STRICT by default -----------------
  if (hasNetflix && !hasAmazon) {
    return {
      priority: allowFallback ? ['netflix', 'amazon'] : ['netflix'],
      strategy: allowFallback ? 'netflix_only_with_fallback' : 'netflix_only_strict',
      reason: 'Netflix is the only indicated provider',
      strict: !allowFallback,
    };
  }
  if (hasAmazon && !hasNetflix) {
    return {
      priority: allowFallback ? ['amazon', 'netflix'] : ['amazon'],
      strategy: allowFallback ? 'amazon_only_with_fallback' : 'amazon_only_strict',
      reason: 'Amazon Prime Video is the only indicated provider',
      strict: !allowFallback,
    };
  }

  // --- Both available → prefer Netflix, fall back to Amazon ---------------
  if (hasNetflix && hasAmazon) {
    return {
      priority: ['netflix', 'amazon'],
      strategy: 'both_prefer_netflix',
      reason: 'Both Netflix and Amazon Prime Video are available',
      strict: false,
    };
  }

  // --- Other OTT only → try both, prefer Netflix --------------------------
  if (providerNames && providerNames.length > 0) {
    return {
      priority: ['netflix', 'amazon'],
      strategy: 'other_ott_try_both',
      reason: `Other OTT only (${providerNames.join(', ')})`,
      strict: false,
    };
  }

  // --- No provider info → try both ---------------------------------------
  return {
    priority: ['netflix', 'amazon'],
    strategy: 'no_providers_try_both',
    reason: 'No providers matched — falling back to both backends',
    strict: false,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 3 — try a backend                                                    */
/* -------------------------------------------------------------------------- */

function backendBaseFor(name) {
  return name === 'netflix' ? NETFLIX_BACKEND_URL : AMAZON_BACKEND_URL;
}

function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titlesRoughlyMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return true; // can't compare → don't block
  if (na === nb) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  // token overlap check
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const common = [...ta].filter(t => tb.has(t)).length;
  return common / Math.max(ta.size, tb.size) >= 0.6;
}

/**
 * Call a backend. Verifies HTTP 200 + ok:true + has stream data.
 * Optionally verifies returned title roughly matches expectedTitle.
 */
async function tryBackend(name, baseUrl, route, { expectedTitle = null } = {}) {
  const url = baseUrl + route;
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, {}, BACKEND_TIMEOUT_MS);
    const elapsed = Date.now() - started;

    if (!res.ok) {
      return { ok: false, backend: name, status: res.status, error: `HTTP ${res.status}`, ms: elapsed };
    }

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return { ok: false, backend: name, status: 200, error: 'non-JSON response', ms: elapsed }; }

    if (!json || json.ok !== true) {
      return {
        ok: false, backend: name, status: 200,
        error: json?.error || 'backend returned ok:false',
        body: json, ms: elapsed,
      };
    }

    const hasMaster  = typeof json.masterPlayable === 'string' && json.masterPlayable.length > 0;
    const hasMaster2 = typeof json.master === 'string' && json.master.length > 0;
    const hasSources = Array.isArray(json.sources) && json.sources.length > 0;

    if (!hasMaster && !hasMaster2 && !hasSources) {
      return { ok: false, backend: name, status: 200, error: 'no stream/master in response', body: json, ms: elapsed };
    }

    // Optional title sanity check — catches cases where the backend
    // fuzzy-matched a completely different entry with the same name.
    if (VERIFY_TITLE && expectedTitle && json.title) {
      if (!titlesRoughlyMatch(json.title, expectedTitle)) {
        return {
          ok: false, backend: name, status: 200,
          error: `title mismatch: backend="${json.title}" expected="${expectedTitle}"`,
          body: json, ms: elapsed,
        };
      }
    }

    return { ok: true, backend: name, status: 200, body: json, ms: elapsed };
  } catch (err) {
    return { ok: false, backend: name, error: err.message, ms: Date.now() - started };
  }
}

/* -------------------------------------------------------------------------- */
/*  Proxy URL rewrite                                                         */
/* -------------------------------------------------------------------------- */

function rewriteProxyUrls(node, backendBase) {
  if (typeof node === 'string') {
    return node.startsWith('/proxy/') ? backendBase + node : node;
  }
  if (Array.isArray(node)) return node.map(n => rewriteProxyUrls(n, backendBase));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteProxyUrls(v, backendBase);
    return out;
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/*  Handler                                                                   */
/* -------------------------------------------------------------------------- */

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

  /* --- /health ----------------------------------------------------------- */
  if (path === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'master-router',
      envLoaded,
      strictRouting: STRICT_ROUTING,
      verifyTitle: VERIFY_TITLE,
      backends: {
        providerLookup: PROVIDER_LOOKUP_URL,
        netflix: NETFLIX_BACKEND_URL,
        amazon: AMAZON_BACKEND_URL,
      },
      providerCacheSize: providerCache.size,
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  /* --- /providers passthrough -------------------------------------------- */
  const provMatch = path.match(/^\/providers\/(movie|tv|show|series|film)\/(\d+)\/?$/i);
  if (provMatch) {
    const type = /^(movie|film)$/i.test(provMatch[1]) ? 'movie' : 'tv';
    const tmdbId = provMatch[2];
    try {
      const data = await fetchProviders(type, tmdbId);
      const allowFallback = url.searchParams.get('fallback') === '1';
      const routing = buildRouting(data.providerNames, {
        allowFallback: allowFallback || !STRICT_ROUTING,
      });
      sendJson(res, 200, { ...data, ...routing });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  /* --- /movie/:tmdbId  |  /tv/:tmdbId/:season/:episode ------------------- */
  const movieMatch = path.match(/^\/movie\/(\d+)\/?$/i);
  const tvMatch    = path.match(/^\/tv\/(\d+)\/(\d+)\/(\d+)\/?$/i);

  if (!movieMatch && !tvMatch) {
    if (path === '/' || path === '') {
      sendJson(res, 200, {
        ok: true,
        service: 'master-router',
        strictRouting: STRICT_ROUTING,
        usage: {
          movie: 'GET /movie/:tmdbId',
          tv:    'GET /tv/:tmdbId/:season/:episode',
          providers: 'GET /providers/movie/:tmdbId  |  GET /providers/tv/:tmdbId',
          fallback: 'append ?fallback=1 to allow cross-backend fallback in single-provider cases',
        },
        backends: {
          providerLookup: PROVIDER_LOOKUP_URL,
          netflix: NETFLIX_BACKEND_URL,
          amazon: AMAZON_BACKEND_URL,
        },
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not Found' });
    return;
  }

  const type     = movieMatch ? 'movie' : 'tv';
  const tmdbId   = movieMatch ? movieMatch[1] : tvMatch[1];
  const season   = movieMatch ? null : Number(tvMatch[2]);
  const episode  = movieMatch ? null : Number(tvMatch[3]);

  const allowFallbackReq = url.searchParams.get('fallback') === '1';

  // Strip master-only params before forwarding to backend
  const fwdParams = new URLSearchParams(url.searchParams);
  fwdParams.delete('fallback');
  const fwdQs = fwdParams.toString() ? `?${fwdParams.toString()}` : '';

  const backendRoute = movieMatch
    ? `/movie/${tmdbId}${fwdQs}`
    : `/tv/${tmdbId}/${season}/${episode}${fwdQs}`;

  /* --- 1. Provider lookup ------------------------------------------------ */
  let providers = [];
  let expectedTitle = null;
  let providersMatched = false;
  let providerLookupError = null;
  try {
    const p = await fetchProviders(type, tmdbId);
    providers = p.providerNames;
    providersMatched = p.matched;
    expectedTitle = p.title;
  } catch (err) {
    providerLookupError = err.message;
    log('warn', 'provider lookup failed', { reqId, type, tmdbId, err: err.message });
  }

  /* --- 2. Routing decision ---------------------------------------------- */
  const allowFallback = allowFallbackReq || !STRICT_ROUTING;
  const { priority, strategy, reason, strict } = buildRouting(providers, { allowFallback });

  log('info', 'routing decided', {
    reqId, tmdbId, type, providers, strategy, priority, strict, reason,
  });

  /* --- 3. Try backends in order ----------------------------------------- */
  const attempts = [];
  for (const name of priority) {
    const base = backendBaseFor(name);
    log('debug', 'trying backend', { reqId, backend: name, base, route: backendRoute });

    const result = await tryBackend(name, base, backendRoute, { expectedTitle });
    attempts.push({
      backend: name,
      baseUrl: base,
      ok: result.ok,
      status: result.status,
      ms: result.ms,
      error: result.error,
    });

    if (result.ok) {
      const stream = rewriteProxyUrls(result.body, base);
      sendJson(res, 200, {
        ok: true,
        service: 'master-router',
        tmdbId,
        type,
        season,
        episode,
        providers,
        providersMatched,
        strategy,
        routingReason: reason,
        strict,
        via: name,
        backend: base,
        attempts,
        stream,
      });
      log('info', 'routed', { reqId, tmdbId, via: name, ms: result.ms });
      return;
    }

    log('warn', 'backend failed', {
      reqId, backend: name, error: result.error, status: result.status,
    });
  }

  /* --- All attempted backends failed ------------------------------------ */
  const hint = strict
    ? `Strict routing: only "${priority[0]}" was tried because it is the sole indicated provider. ` +
      `Append ?fallback=1 to allow the other backend as a fallback.`
    : null;

  sendJson(res, 502, {
    ok: false,
    service: 'master-router',
    error: 'No backend could resolve this title',
    hint,
    tmdbId,
    type,
    season,
    episode,
    providers,
    providersMatched,
    strategy,
    routingReason: reason,
    strict,
    providerLookupError,
    attempts,
  });
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

server.requestTimeout   = 60000;
server.headersTimeout   = 20000;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  log('info', 'master-router listening', {
    url: `http://${HOST}:${PORT}`,
    env: envLoaded ? envPath : '(no .env)',
    strictRouting: STRICT_ROUTING,
    verifyTitle: VERIFY_TITLE,
    providerLookup: PROVIDER_LOOKUP_URL,
    netflix: NETFLIX_BACKEND_URL,
    amazon: AMAZON_BACKEND_URL,
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
process.on('uncaughtException',  (err)    => {
  log('error', 'uncaughtException', { err: err.stack || err.message });
  shutdown('uncaughtException');
});