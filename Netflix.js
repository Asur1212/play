/* ============================================================================
 *  NetMirror HLS Resolver — production-grade
 *  Permanent metadata (audio + subtitle arrays in single JSONB rows)
 *  + 30-minute ephemeral token cache, PostgreSQL (Aiven) backed
 *  ---------------------------------------------------------------------------
 *  Endpoints:
 *    GET /movie/:tmdbId
 *    GET /tv/:tmdbId/:season/:episode
 *    GET /api/stream/:net77Id
 *    GET /health
 *    GET /*                                       (static / SPA)
 *
 *  DATABASE MODEL
 *  --------------
 *  PERMANENT (never auto-deleted):
 *    tmdb_cache           (tmdb_id, type) -> raw TMDB JSON
 *    net77_search_cache   title_key       -> net77 search result
 *    net77_id_map         slug_key        -> {net77_id, series_id, season_id, episode_id, title}
 *    audio_tracks         net77_id        -> tracks JSONB  (array of audio tracks)
 *    subtitle_tracks      net77_id        -> tracks JSONB  (array of subtitle tracks)
 *
 *  EPHEMERAL (expires_at = NOW() + 30 min, cleaned every 5 min):
 *    stream_resolved      net77_id        -> master_url, h_token, sources, payload
 *
 *  DEDUP RULES
 *  -----------
 *    audio    : unique by uri     (deduped in JS before UPSERT)
 *    subtitle : unique by srtUrl  (deduped in JS before UPSERT)
 *    Both tables always hold exactly ONE row per net77_id.
 * ==========================================================================*/

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

const sourceDir  = join(rootDir, 'src');
const playerFile = join(sourceDir, 'index.html');

const PORT               = Number(process.env.PORT || 3000);
const HOST               = process.env.HOST || '0.0.0.0';
const HEALTH_PATH        = '/health';
const API_PATH           = '/api/stream';

const LOG_LEVEL          = (process.env.LOG_LEVEL || 'info').toLowerCase();
const FETCH_TIMEOUT_MS   = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const TOKEN_CACHE_TTL    = Number(process.env.TOKEN_CACHE_TTL || 1800) * 1000;   // 30 min
const REQUEST_DELAY_MS   = Number(process.env.REQUEST_DELAY_MS || 150);
const MAX_CONCURRENT     = Number(process.env.MAX_CONCURRENT || 8);
const CDN_DELAY_MS       = Number(process.env.CDN_DELAY_MS || 50);
const EPISODE_MAX_PAGES  = Number(process.env.EPISODE_MAX_PAGES || 10);

const TMDB_RETRIES       = Number(process.env.TMDB_RETRIES || 5);
const TMDB_RETRY_BASE_MS = Number(process.env.TMDB_RETRY_BASE_MS || 400);

const NET77_BASE     = (process.env.NET77_BASE || 'https://net77.cc').replace(/\/+$/, '');
const NET52_BASE     = (process.env.NET52_BASE || 'https://net52.cc').replace(/\/+$/, '');
const NET77_COOKIE   = (process.env.NET77_COOKIE || '').trim();
const MASTER_H_TOKEN = (process.env.MASTER_H_TOKEN || '').trim();
const FALLBACK_ID    = (process.env.FALLBACK_ID || '').trim();

const TMDB_PROXY   = (process.env.TMDB_PROXY || '').replace(/\/+$/, '');
const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();

const UPSTREAM_UA = process.env.UPSTREAM_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/* --- PostgreSQL (Aiven) --------------------------------------------------- */
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://avnadmin:AVNS_ELXgwt5oRsys2DqEaY4@pg-3c0dcf0d-airpos0-18fd.k.aivencloud.com:10317/defaultdb?sslmode=require';

const PG_POOL_MAX             = Number(process.env.PG_POOL_MAX || 15);
const PG_CLEANUP_INTERVAL_MS  = Number(process.env.PG_CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
const L1_MAX_ENTRIES          = Number(process.env.L1_MAX_ENTRIES || 2000);

/* -------------------------------------------------------------------------- */
/*  Logger                                                                    */
/* -------------------------------------------------------------------------- */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const level = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(lvl, msg, meta) {
  if (LEVELS[lvl] > level) return;
  const ts = new Date().toISOString();
  const tag = lvl.toUpperCase().padEnd(5);
  const line = meta ? `${ts} ${tag} ${msg} ${JSON.stringify(meta)}` : `${ts} ${tag} ${msg}`;
  (lvl === 'error' ? console.error : console.log)(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/*  PostgreSQL layer                                                          */
/* -------------------------------------------------------------------------- */

function buildPgConfig(uri) {
  const u = new URL(uri);
  const sslmode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  const cfg = {
    connectionString: u.toString(),
    max: PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'netmirror-hls-resolver',
  };
  if (sslmode && sslmode !== 'disable') cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}

let dbPool = null;
let dbEnabled = false;

async function initDatabase() {
  try {
    dbPool = new Pool(buildPgConfig(DATABASE_URL));
    dbPool.on('error', (err) => log('error', 'pg pool idle error', { err: err.message }));

    const c = await dbPool.connect();
    try { await c.query('SELECT 1'); } finally { c.release(); }

    /* ---- SCHEMA VERSION TRACKING + MIGRATION -------------------------- */

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        id         INT PRIMARY KEY,
        version    INT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const mig = await dbPool.query(`SELECT COALESCE(MAX(version), 0) AS v FROM _schema_version WHERE id = 1`);
    const currentVersion = Number(mig.rows[0].v || 0);

    if (currentVersion < 3) {
      log('info', 'db migration -> v3 (one row per episode for audio/subtitle)');
      await dbPool.query(`DROP TABLE IF EXISTS audio_tracks CASCADE`);
      await dbPool.query(`DROP TABLE IF EXISTS subtitle_tracks CASCADE`);
      await dbPool.query(`
        INSERT INTO _schema_version (id, version) VALUES (1, 3)
        ON CONFLICT (id) DO UPDATE SET version = 3, applied_at = NOW()
      `);
    }

    /* ---- PERMANENT TABLES -------------------------------------------- */

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tmdb_cache (
        tmdb_id     TEXT        NOT NULL,
        type        TEXT        NOT NULL,
        payload     JSONB       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tmdb_id, type)
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS net77_search_cache (
        title_key   TEXT        PRIMARY KEY,
        result      JSONB       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS net77_id_map (
        slug_key    TEXT        PRIMARY KEY,
        net77_id    TEXT        NOT NULL,
        series_id   TEXT,
        season_id   TEXT,
        episode_id  TEXT,
        title       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS net77_id_map_net77_id_idx ON net77_id_map (net77_id);
    `);

    /* ---- PERMANENT: AUDIO TRACKS (ONE ROW PER EPISODE) ---------------- */
    // tracks = JSONB array of { uri, lang, name, codec, default, channels }
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS audio_tracks (
        net77_id    TEXT        PRIMARY KEY,
        tracks      JSONB       NOT NULL DEFAULT '[]'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    /* ---- PERMANENT: SUBTITLE TRACKS (ONE ROW PER EPISODE) ------------- */
    // tracks = JSONB array of { srtUrl, lang, name, codec, default }
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS subtitle_tracks (
        net77_id    TEXT        PRIMARY KEY,
        tracks      JSONB       NOT NULL DEFAULT '[]'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    /* ---- EPHEMERAL TABLE (30-min TTL) --------------------------------- */

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS stream_resolved (
        net77_id      TEXT        PRIMARY KEY,
        master_url    TEXT        NOT NULL,
        h_token       TEXT,
        sources       JSONB       NOT NULL DEFAULT '[]'::jsonb,
        thumbnail_url TEXT,
        payload       JSONB       NOT NULL,
        resolved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL
      );
    `);
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS stream_resolved_expires_idx
        ON stream_resolved (expires_at);
    `);
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS stream_resolved_master_idx
        ON stream_resolved (master_url);
    `);

    dbEnabled = true;
    log('info', 'postgres ready', { host: new URL(DATABASE_URL).host, poolMax: PG_POOL_MAX });

    // Periodic cleanup — ONLY touches the ephemeral table.
    const timer = setInterval(async () => {
      if (!dbEnabled) return;
      try {
        const r = await dbPool.query('DELETE FROM stream_resolved WHERE expires_at < NOW()');
        if (r.rowCount) log('debug', 'db cleanup', { stream_resolved: r.rowCount });
      } catch (err) {
        log('warn', 'db cleanup failed', { err: err.message });
      }
    }, PG_CLEANUP_INTERVAL_MS);
    timer.unref();
  } catch (err) {
    dbEnabled = false;
    log('error', 'postgres init failed — falling back to in-memory only', { err: err.message });
  }
}

/* -------------------------------------------------------------------------- */
/*  L1 in-memory LRU                                                          */
/* -------------------------------------------------------------------------- */

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(k, v);
  }
  delete(k) { this.map.delete(k); }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

const l1Stream       = new Lru(L1_MAX_ENTRIES);   // net77_id -> {data, expiresAt}
const l1Tmdb         = new Lru(L1_MAX_ENTRIES);
const l1Search       = new Lru(L1_MAX_ENTRIES);
const l1IdMap        = new Lru(L1_MAX_ENTRIES);

/* -------------------------------------------------------------------------- */
/*  PERMANENT cache — TMDB                                                    */
/* -------------------------------------------------------------------------- */

async function getTmdbCache(tmdbId, type) {
  const k = `${type}:${tmdbId}`;
  const mem = l1Tmdb.get(k);
  if (mem) return mem;
  if (!dbEnabled) return null;
  try {
    const { rows } = await dbPool.query(
      'SELECT payload FROM tmdb_cache WHERE tmdb_id = $1 AND type = $2 LIMIT 1',
      [String(tmdbId), type]
    );
    if (rows.length === 0) return null;
    l1Tmdb.set(k, rows[0].payload);
    return rows[0].payload;
  } catch (err) {
    log('warn', 'getTmdbCache db error', { err: err.message });
    return null;
  }
}

async function setTmdbCache(tmdbId, type, payload) {
  const k = `${type}:${tmdbId}`;
  l1Tmdb.set(k, payload);
  if (!dbEnabled) return;
  try {
    await dbPool.query(
      `INSERT INTO tmdb_cache (tmdb_id, type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tmdb_id, type) DO UPDATE
         SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [String(tmdbId), type, JSON.stringify(payload)]
    );
  } catch (err) {
    log('warn', 'setTmdbCache db error', { err: err.message });
  }
}

/* -------------------------------------------------------------------------- */
/*  PERMANENT cache — net77 search                                            */
/* -------------------------------------------------------------------------- */

async function getSearchCache(titleKey) {
  const mem = l1Search.get(titleKey);
  if (mem) return mem;
  if (!dbEnabled) return null;
  try {
    const { rows } = await dbPool.query(
      'SELECT result FROM net77_search_cache WHERE title_key = $1 LIMIT 1',
      [titleKey]
    );
    if (rows.length === 0) return null;
    l1Search.set(titleKey, rows[0].result);
    return rows[0].result;
  } catch (err) {
    log('warn', 'getSearchCache db error', { err: err.message });
    return null;
  }
}

async function setSearchCache(titleKey, result) {
  l1Search.set(titleKey, result);
  if (!dbEnabled) return;
  try {
    await dbPool.query(
      `INSERT INTO net77_search_cache (title_key, result)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (title_key) DO UPDATE
         SET result = EXCLUDED.result, created_at = NOW()`,
      [titleKey, JSON.stringify(result)]
    );
  } catch (err) {
    log('warn', 'setSearchCache db error', { err: err.message });
  }
}

/* -------------------------------------------------------------------------- */
/*  PERMANENT cache — slug -> net77 id map                                    */
/* -------------------------------------------------------------------------- */

async function getIdMap(slugKey) {
  const mem = l1IdMap.get(slugKey);
  if (mem) return mem;
  if (!dbEnabled) return null;
  try {
    const { rows } = await dbPool.query(
      `SELECT net77_id, series_id, season_id, episode_id, title
         FROM net77_id_map WHERE slug_key = $1 LIMIT 1`,
      [slugKey]
    );
    if (rows.length === 0) return null;
    l1IdMap.set(slugKey, rows[0]);
    return rows[0];
  } catch (err) {
    log('warn', 'getIdMap db error', { err: err.message });
    return null;
  }
}

async function setIdMap(slugKey, { net77Id, seriesId, seasonId, episodeId, title }) {
  const row = {
    net77_id: String(net77Id),
    series_id: seriesId ? String(seriesId) : null,
    season_id: seasonId ? String(seasonId) : null,
    episode_id: episodeId ? String(episodeId) : null,
    title: title || null,
  };
  l1IdMap.set(slugKey, row);
  if (!dbEnabled) return;
  try {
    await dbPool.query(
      `INSERT INTO net77_id_map (slug_key, net77_id, series_id, season_id, episode_id, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug_key) DO UPDATE
         SET net77_id = EXCLUDED.net77_id,
             series_id = EXCLUDED.series_id,
             season_id = EXCLUDED.season_id,
             episode_id = EXCLUDED.episode_id,
             title = EXCLUDED.title,
             updated_at = NOW()`,
      [slugKey, row.net77_id, row.series_id, row.season_id, row.episode_id, row.title]
    );
  } catch (err) {
    log('warn', 'setIdMap db error', { err: err.message });
  }
}

/* -------------------------------------------------------------------------- */
/*  PERMANENT metadata — AUDIO (one row per episode)                          */
/* -------------------------------------------------------------------------- */

/**
 * Deduplicate audio tracks by uri. Returns a new array.
 */
function dedupAudioTracks(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks || []) {
    if (!t || !t.uri) continue;
    const key = String(t.uri);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      uri: String(t.uri),
      lang: String(t.lang || t.language || 'und').toLowerCase() || 'und',
      name: String(t.name || t.label || 'Audio'),
      codec: t.codec || null,
      default: Boolean(t.default),
      channels: t.channels || null,
    });
  }
  return out;
}

async function replaceAudioTracks(net77Id, tracks) {
  const deduped = dedupAudioTracks(tracks);
  if (!dbEnabled) return deduped;
  try {
    await dbPool.query(
      `INSERT INTO audio_tracks (net77_id, tracks, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (net77_id) DO UPDATE
         SET tracks = EXCLUDED.tracks, updated_at = NOW()`,
      [String(net77Id), JSON.stringify(deduped)]
    );
  } catch (err) {
    log('warn', 'replaceAudioTracks db error', { err: err.message });
  }
  return deduped;
}

/* -------------------------------------------------------------------------- */
/*  PERMANENT metadata — SUBTITLES (one row per episode)                      */
/* -------------------------------------------------------------------------- */

/**
 * Deduplicate subtitle tracks by srtUrl. Returns a new array.
 */
function dedupSubtitleTracks(subs) {
  const seen = new Set();
  const out = [];
  for (const s of subs || []) {
    if (!s || !s.srtUrl) continue;
    const key = String(s.srtUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      srtUrl: String(s.srtUrl),
      lang: String(s.lang || 'und').toLowerCase() || 'und',
      name: String(s.name || 'Subtitles'),
      codec: s.codec || 'srt',
      default: Boolean(s.default),
    });
  }
  return out;
}

async function replaceSubtitleTracks(net77Id, subs) {
  const deduped = dedupSubtitleTracks(subs);
  if (!dbEnabled) return deduped;
  try {
    await dbPool.query(
      `INSERT INTO subtitle_tracks (net77_id, tracks, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (net77_id) DO UPDATE
         SET tracks = EXCLUDED.tracks, updated_at = NOW()`,
      [String(net77Id), JSON.stringify(deduped)]
    );
  } catch (err) {
    log('warn', 'replaceSubtitleTracks db error', { err: err.message });
  }
  return deduped;
}

/* -------------------------------------------------------------------------- */
/*  EPHEMERAL cache — stream_resolved                                         */
/* -------------------------------------------------------------------------- */

async function getStreamResolved(net77Id) {
  const mem = l1Stream.get(net77Id);
  if (mem && Date.now() < mem.expiresAt) return mem.data;
  if (mem) l1Stream.delete(net77Id);
  if (!dbEnabled) return null;
  try {
    const { rows } = await dbPool.query(
      `SELECT payload, expires_at FROM stream_resolved
        WHERE net77_id = $1 AND expires_at > NOW() LIMIT 1`,
      [String(net77Id)]
    );
    if (rows.length === 0) return null;
    const expiresAt = new Date(rows[0].expires_at).getTime();
    l1Stream.set(net77Id, { data: rows[0].payload, expiresAt });
    return rows[0].payload;
  } catch (err) {
    log('warn', 'getStreamResolved db error', { err: err.message });
    return null;
  }
}

async function setStreamResolved(net77Id, {
  masterUrl, hToken, sources, thumbnailUrl, payload,
}) {
  const expiresAt = Date.now() + TOKEN_CACHE_TTL;
  l1Stream.set(net77Id, { data: payload, expiresAt });
  if (!dbEnabled) return;
  try {
    await dbPool.query(
      `INSERT INTO stream_resolved
         (net77_id, master_url, h_token, sources, thumbnail_url, payload, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (net77_id) DO UPDATE
         SET master_url    = EXCLUDED.master_url,
             h_token       = EXCLUDED.h_token,
             sources       = EXCLUDED.sources,
             thumbnail_url = EXCLUDED.thumbnail_url,
             payload       = EXCLUDED.payload,
             resolved_at   = NOW(),
             expires_at    = EXCLUDED.expires_at`,
      [
        String(net77Id),
        masterUrl,
        hToken || null,
        JSON.stringify(sources || []),
        thumbnailUrl || null,
        JSON.stringify(payload),
        new Date(expiresAt),
      ]
    );
  } catch (err) {
    log('warn', 'setStreamResolved db error', { err: err.message });
  }
}

/* -------------------------------------------------------------------------- */
/*  Token helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizeToken(token) {
  if (!token) return '';
  let t = String(token).trim();
  while (t.startsWith('in=')) t = t.slice(3);
  return t;
}

function withToken(url, rawToken) {
  const token = normalizeToken(rawToken);
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('in', token);
    return u.href;
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}in=${encodeURIComponent(token)}`;
  }
}

function ensureToken(url, rawToken) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('in')) {
      const existing = u.searchParams.get('in') || '';
      if (existing.startsWith('in=')) {
        u.searchParams.set('in', normalizeToken(existing));
        return u.href;
      }
      return u.href;
    }
  } catch {}
  return withToken(url, rawToken);
}

/* -------------------------------------------------------------------------- */
/*  Cookie jar                                                                */
/* -------------------------------------------------------------------------- */

const cookieJar = new Map();

function storeCookies(hostname, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  const existing = cookieJar.get(hostname) || new Map();
  for (const raw of setCookieHeaders) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) existing.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  cookieJar.set(hostname, existing);
}

function cookieHeaderFor(hostname) {
  const jar = cookieJar.get(hostname);
  if (!jar || jar.size === 0) return '';
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/* -------------------------------------------------------------------------- */
/*  Rate limiter + resilient fetch                                            */
/* -------------------------------------------------------------------------- */

let activeFetchCount = 0;
const fetchQueue = [];

async function waitForSlot() {
  if (activeFetchCount < MAX_CONCURRENT) { activeFetchCount++; return; }
  return new Promise(resolve => fetchQueue.push(resolve));
}

function releaseSlot() {
  activeFetchCount--;
  const next = fetchQueue.shift();
  if (next) { activeFetchCount++; next(); }
}

async function netFetch(url, { method = 'GET', body, headers = {}, redirect = 'follow', skipThrottle = false } = {}) {
  if (!skipThrottle) await waitForSlot();
  const parsed = new URL(url);
  const host = parsed.hostname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const finalHeaders = {
    'User-Agent': UPSTREAM_UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': NET77_BASE,
    'Referer': NET77_BASE + '/',
    ...headers,
  };

  const jar = cookieHeaderFor(host);
  if (jar) finalHeaders.Cookie = jar;

  try {
    if (!skipThrottle && CDN_DELAY_MS > 0) await sleep(CDN_DELAY_MS);
    const res = await fetch(url, {
      method, headers: finalHeaders, body, redirect,
      cache: 'no-store', signal: controller.signal,
    });
    const setCookies = (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) || [];
    storeCookies(host, setCookies);
    return res;
  } finally {
    clearTimeout(timer);
    if (!skipThrottle) releaseSlot();
  }
}

async function fetchWithRetry(url, options = {}, { retries = TMDB_RETRIES, baseDelay = TMDB_RETRY_BASE_MS, label = 'fetch' } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await netFetch(url, { ...options, skipThrottle: true });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error(`${label} HTTP ${res.status}`);
      log('warn', 'retrying', { label, attempt: i + 1, status: res.status });
    } catch (err) {
      lastErr = err;
      log('warn', 'retrying', { label, attempt: i + 1, err: err.message });
    }
    if (i < retries - 1) await sleep(baseDelay * Math.pow(2, i));
  }
  throw lastErr || new Error(`${label} failed after ${retries} attempts`);
}

/* -------------------------------------------------------------------------- */
/*  TMDB lookup — PERMANENT cache                                             */
/* -------------------------------------------------------------------------- */

async function fetchTmdbTitle(tmdbId, type, { force = false } = {}) {
  if (!TMDB_PROXY && !TMDB_API_KEY) {
    throw new Error('TMDB_PROXY or TMDB_API_KEY must be set in .env');
  }

  if (!force) {
    const cached = await getTmdbCache(tmdbId, type);
    if (cached) {
      log('debug', 'tmdb cache hit', { tmdbId, type });
      return { title: cached.title, raw: cached.raw };
    }
  }

  const endpoint = type === 'movie' ? 'movie' : 'tv';
  const url = TMDB_PROXY
    ? `${TMDB_PROXY}/${endpoint}/${tmdbId}`
    : `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;

  const res = await fetchWithRetry(url, { headers: { Referer: url } }, { label: `tmdb ${endpoint}/${tmdbId}` });
  if (!res.ok) throw new Error(`TMDB ${endpoint}/${tmdbId} HTTP ${res.status}`);

  const data = await res.json();
  const title = type === 'movie'
    ? (data.title || data.original_title)
    : (data.name || data.original_name);
  if (!title) throw new Error(`TMDB returned no title for ${type}/${tmdbId}`);

  const payload = { title: String(title).trim(), raw: data };
  await setTmdbCache(tmdbId, type, payload);
  return payload;
}

/* -------------------------------------------------------------------------- */
/*  net77 helpers — PERMANENT search cache                                    */
/* -------------------------------------------------------------------------- */

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickBestMatch(results, wanted) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const want = normalizeForMatch(wanted);

  const exact = results.find(r => normalizeForMatch(r.t) === want);
  if (exact) return exact;

  const startsWith = results
    .filter(r => normalizeForMatch(r.t).startsWith(want) || want.startsWith(normalizeForMatch(r.t)))
    .sort((a, b) => normalizeForMatch(a.t).length - normalizeForMatch(b.t).length);
  if (startsWith.length) return startsWith[0];

  if (results.length === 1) return results[0];
  return null;
}

function net77Headers(extra = {}) {
  const h = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': NET77_BASE + '/home',
    'Origin': NET77_BASE,
    ...extra,
  };
  if (NET77_COOKIE) h.Cookie = NET77_COOKIE;
  return h;
}

async function searchNet77(query, { force = false } = {}) {
  const key = normalizeForMatch(query);

  if (!force) {
    const cached = await getSearchCache(key);
    if (cached) {
      log('debug', 'net77 search cache hit', { query });
      return cached;
    }
  }

  const url = `${NET77_BASE}/search.php?s=${encodeURIComponent(query)}&t=${Math.floor(Date.now() / 1000)}`;
  log('debug', 'net77: search.php', { query });

  const res = await fetchWithRetry(url, { headers: net77Headers() }, { label: 'net77 search' });
  if (!res.ok) throw new Error(`net77 search.php HTTP ${res.status}`);

  const json = await res.json();
  const results = Array.isArray(json?.searchResult) ? json.searchResult : [];
  const best = pickBestMatch(results, query);
  if (!best) {
    throw new Error(
      `No exact match on net77 for "${query}" ` +
      `(${results.length} results: ${results.slice(0, 5).map(r => r.t).join(' | ')})`
    );
  }
  await setSearchCache(key, best);
  return best;
}

async function fetchNet77Post(net77Id) {
  const url = `${NET77_BASE}/post.php?id=${encodeURIComponent(net77Id)}&t=${Math.floor(Date.now() / 1000)}`;
  log('debug', 'net77: post.php', { net77Id });
  const res = await fetchWithRetry(url, { headers: net77Headers() }, { label: 'net77 post' });
  if (!res.ok) throw new Error(`net77 post.php HTTP ${res.status}`);
  return await res.json();
}

async function fetchNet77Episodes(seriesId, seasonId, page = 1) {
  const ts = Math.floor(Date.now() / 1000);
  let url = `${NET77_BASE}/episodes.php?s=${encodeURIComponent(seasonId)}&series=${encodeURIComponent(seriesId)}&t=${ts}`;
  if (page > 1) url += `&page=${page}`;
  log('debug', 'net77: episodes.php', { seriesId, seasonId, page });

  const res = await fetchWithRetry(url, { headers: net77Headers() }, { label: 'net77 episodes' });
  if (!res.ok) throw new Error(`net77 episodes.php HTTP ${res.status}`);
  return await res.json();
}

function pickSeason(postData, seasonNumber) {
  const seasons = Array.isArray(postData?.season) ? postData.season : [];
  if (seasons.length === 0) throw new Error('post.php returned no seasons');

  const want = Number(seasonNumber);
  const match = seasons.find(s => Number(String(s.s || '').replace(/[^0-9]/g, '')) === want);

  if (!match) {
    const available = seasons.map(s => `S${s.s}`).join(', ');
    throw new Error(`Season ${seasonNumber} not found (available: ${available})`);
  }
  return match;
}

async function findEpisode(seriesId, seasonId, seasonNumber, episodeNumber) {
  const wantS = `S${Number(seasonNumber)}`.toUpperCase();
  const wantE = String(Number(episodeNumber));
  const seen = [];

  let page = 1;
  for (let i = 0; i < EPISODE_MAX_PAGES; i++) {
    const data = await fetchNet77Episodes(seriesId, seasonId, page);
    const episodes = Array.isArray(data?.episodes) ? data.episodes : [];

    for (const ep of episodes) {
      seen.push(`S${ep.s}E${ep.ep}`);
      if (String(ep.s || '').toUpperCase() === wantS && String(Number(ep.ep)) === wantE) return ep;
    }

    const next = Number(data?.nextPage || 0);
    if (!next || next === page) break;
    page = next;
    await sleep(REQUEST_DELAY_MS);
  }

  const preview = seen.slice(0, 8).join(', ');
  throw new Error(
    `Episode S${seasonNumber}E${episodeNumber} not found on net77 ` +
    `(checked: ${preview}${seen.length > 8 ? `, … (${seen.length} total)` : ''})`
  );
}

/* -------------------------------------------------------------------------- */
/*  Slug -> net77 id — PERMANENT id map                                       */
/* -------------------------------------------------------------------------- */

function slugKey({ type, tmdbId, season, episode }) {
  return type === 'movie'
    ? `movie:${tmdbId}`
    : `tv:${tmdbId}:${Number(season)}:${Number(episode)}`;
}

async function resolveSlugId({ type, tmdbId, season, episode }, { force = false } = {}) {
  const key = slugKey({ type, tmdbId, season, episode });

  if (!force) {
    const mapped = await getIdMap(key);
    if (mapped) {
      log('info', 'slug map hit', { key, net77Id: mapped.net77_id });
      return {
        net77Id: mapped.net77_id,
        title: mapped.title || '',
        seriesId: mapped.series_id,
        seasonId: mapped.season_id,
        episodeId: mapped.episode_id,
      };
    }
  }

  const { title } = await fetchTmdbTitle(tmdbId, type, { force });
  log('info', 'tmdb resolved', { type, tmdbId, title });

  const search = await searchNet77(title, { force });
  log('info', 'net77 search hit', { net77Id: search.id, net77Title: search.t });

  if (type === 'movie') {
    const out = { net77Id: search.id, title, seriesId: search.id, episodeId: null };
    await setIdMap(key, out);
    return out;
  }

  const post = await fetchNet77Post(search.id);
  const seasonEntry = pickSeason(post, season);
  log('debug', 'season resolved', { seriesId: search.id, season, seasonId: seasonEntry.id });

  const ep = await findEpisode(search.id, seasonEntry.id, season, episode);
  log('info', 'episode resolved', { seriesId: search.id, seasonId: seasonEntry.id, episodeId: ep.id, title: ep.t });

  const out = {
    net77Id: ep.id,
    title,
    seriesId: search.id,
    seasonId: seasonEntry.id,
    episodeId: ep.id,
    episodeTitle: ep.t,
  };
  await setIdMap(key, out);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Stream resolution chain                                                   */
/* -------------------------------------------------------------------------- */

async function fetchTokenFromNet77(id) {
  if (MASTER_H_TOKEN && FALLBACK_ID && String(id) === FALLBACK_ID) return MASTER_H_TOKEN;

  const url = `${NET77_BASE}/play.php`;
  const body = new URLSearchParams({ id: String(id) }).toString();

  const extraHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': NET77_BASE + '/home',
    'Origin': NET77_BASE,
  };
  if (NET77_COOKIE) extraHeaders.Cookie = NET77_COOKIE;

  const res = await fetchWithRetry(url, { method: 'POST', body, headers: extraHeaders }, { label: 'net77 play' });
  if (!res.ok) throw new Error(`net77 play.php HTTP ${res.status}`);

  let json;
  try { json = await res.json(); } catch { throw new Error('net77 play.php returned non-JSON'); }

  const h = typeof json?.h === 'string' ? json.h : '';
  if (!h.includes('in=') || h.includes('unknown::')) {
    throw new Error('net77 returned a placeholder token. Your NET77_COOKIE may be expired.');
  }
  return h;
}

async function warmNet52Session(id, hToken) {
  const url = `${NET52_BASE}/play.php?id=${encodeURIComponent(id)}&${hToken}`;
  const res = await netFetch(url, {
    skipThrottle: true,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': NET77_BASE + '/',
      'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
    },
  });
  if (!res.ok) throw new Error(`net52 play.php HTTP ${res.status}`);
  const html = await res.text();
  const attrs = {};
  const bodyMatch = html.match(/<body([^>]*)>/i);
  if (bodyMatch) {
    const re = /data-([a-z0-9_-]+)="([^"]*)"/gi;
    let m;
    while ((m = re.exec(bodyMatch[1])) !== null) attrs[m[1]] = m[2];
  }
  return { html, attrs };
}

async function fetchPlaylist(id, hToken, title, tm) {
  const params = new URLSearchParams({
    id: String(id), t: title || '',
    tm: tm || Math.floor(Date.now() / 1000).toString(),
    h: hToken,
  });
  const url = `${NET52_BASE}/playlist.php?${params.toString()}`;
  const res = await fetchWithRetry(url, {
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${NET52_BASE}/play.php?id=${encodeURIComponent(id)}&${hToken}`,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
  }, { label: 'net52 playlist' });
  if (!res.ok) throw new Error(`net52 playlist.php HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) throw new Error('playlist.php returned empty');
  return json[0];
}

function toAbsoluteNet52(file) {
  if (/^https?:\/\//i.test(file)) return file;
  return `${NET52_BASE}${file.startsWith('/') ? '' : '/'}${file}`;
}

function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const audio = [], video = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      if (/TYPE=AUDIO/i.test(line)) {
        const lang = /LANGUAGE="([^"]*)"/i.exec(line)?.[1] || '';
        const name = /NAME="([^"]*)"/i.exec(line)?.[1] || '';
        const uri  = /URI="([^"]*)"/i.exec(line)?.[1] || '';
        const def  = /DEFAULT=YES/i.test(line);
        if (uri) audio.push({ lang, name, uri: new URL(uri, baseUrl).href, default: def });
      }
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bw  = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] || 0);
      const res = /RESOLUTION=(\d+x\d+)/i.exec(line)?.[1] || '';
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) {
        video.push({ bandwidth: bw, resolution: res, uri: new URL(next.trim(), baseUrl).href, default: /DEFAULT=YES/i.test(line) });
      }
    }
  }
  return { audio, video };
}

/**
 * Parse the net52 `tracks[]` array into our clean subtitle shape.
 * Dedup by srtUrl here, so downstream never sees duplicates.
 */
function extractSubtitleMeta(tracks) {
  const raw = (tracks || [])
    .filter(t => t && t.kind === 'captions' && t.file)
    .map(t => {
      const rawFile = String(t.file).trim();
      const url = rawFile.startsWith('//') ? `https:${rawFile}` : rawFile;
      return {
        lang: String(t.language || t.label || 'und').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'und',
        name: String(t.label || t.language || 'Subtitles'),
        srtUrl: url,
        codec: t.codec || 'srt',
        default: Boolean(t.default),
      };
    });
  return dedupSubtitleTracks(raw);
}

function findThumbnailTrack(tracks) {
  return (tracks || []).find(t => t && t.kind === 'thumbnails' && t.file) || null;
}

async function resolveStream(id, { force = false } = {}) {
  if (!force) {
    const cached = await getStreamResolved(id);
    if (cached) return cached;
  }

  log('info', 'resolving stream', { id });
  const hToken = await fetchTokenFromNet77(id);
  await sleep(REQUEST_DELAY_MS);

  let attrs = {};
  try { attrs = (await warmNet52Session(id, hToken)).attrs || {}; }
  catch (err) { log('warn', 'warmup failed', { err: err.message }); }
  await sleep(REQUEST_DELAY_MS);

  const entry = await fetchPlaylist(id, hToken, attrs.title || '', attrs.time || '');
  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  if (sources.length === 0) throw new Error('no sources');

  const defaultSrc = sources.find(s => s.default === 'true') || sources[0];
  let masterUrl = toAbsoluteNet52(defaultSrc.file);
  masterUrl = ensureToken(masterUrl, hToken);

  const masterRes = await netFetch(masterUrl, {
    skipThrottle: true,
    headers: { 'Referer': NET52_BASE + '/', 'Origin': NET52_BASE },
  });
  if (!masterRes.ok) throw new Error(`master HTTP ${masterRes.status}`);
  const masterText = await masterRes.text();

  if (masterText.includes('unknown::')) throw new Error('Placeholder master playlist received');

  const { audio, video } = parseMasterPlaylist(masterText, masterUrl);
  const tracks = Array.isArray(entry.tracks) ? entry.tracks : [];
  const subtitleFull = extractSubtitleMeta(tracks);
  const thumbnail = findThumbnailTrack(tracks);

  // ---------- PERMANENT: one row per episode, deduped ----------
  const [cleanAudio, cleanSubs] = await Promise.all([
    replaceAudioTracks(id, audio),
    replaceSubtitleTracks(id, subtitleFull),
  ]);

  // ---------- Build the response payload ----------
  const subtitlePayload = cleanSubs.map(({ lang, name, srtUrl }) => ({ lang, name, srtUrl }));
  const sourcePayload = sources.map(s => {
    const file = ensureToken(toAbsoluteNet52(s.file), hToken);
    return {
      label: s.label,
      file,
      fileEncoded: encodeURIComponent(file),
      default: s.default === 'true',
    };
  });

  const thumbnailPayload = thumbnail ? {
    file: thumbnail.file.startsWith('//') ? `https:${thumbnail.file}` : thumbnail.file,
    label: thumbnail.label || 'Thumbnails',
    language: thumbnail.language || 'und',
  } : null;

  const result = {
    id: String(id),
    h: hToken,
    title: entry.title || '',
    image: entry.image2 || '',
    master: masterUrl,
    masterEncoded: encodeURIComponent(masterUrl),
    sources: sourcePayload,
    audio: cleanAudio,
    video,
    subtitles: subtitlePayload,
    thumbnails: thumbnailPayload,
    tracks,
    ts: Date.now(),
  };

  // ---------- EPHEMERAL: 30-minute cache of master + sources ----------
  await setStreamResolved(id, {
    masterUrl,
    hToken,
    sources: sourcePayload,
    thumbnailUrl: thumbnailPayload ? thumbnailPayload.file : null,
    payload: result,
  });

  log('info', 'resolved stream', {
    id,
    audioTracks: cleanAudio.length,
    videoVariants: video.length,
    subtitles: subtitlePayload.length,
    hasThumbnails: Boolean(thumbnail),
  });
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Static / helpers                                                          */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
  '.webp': 'image/webp', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...BASE_SECURITY_HEADERS, ...extra });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8', { 'Access-Control-Allow-Origin': '*' });
}

function safeSourcePath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = normalize(join(sourceDir, requested));
  return candidate.startsWith(sourceDir + sep) || candidate === sourceDir ? candidate : null;
}

function serveStatic(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const type = CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const isAppShell = type.startsWith('text/html') || type.includes('javascript') || type.startsWith('text/css');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': isAppShell ? 'no-store' : 'public, max-age=3600', ...BASE_SECURITY_HEADERS });
  createReadStream(filePath).pipe(res);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Response helpers                                                          */
/* -------------------------------------------------------------------------- */

async function respondWithStream(res, net77Id, title, {
  force = false, raw = false,
  tmdbId, type, season, episode,
  seriesId, seasonId, episodeId,
} = {}) {
  const info = await resolveStream(net77Id, { force });

  if (raw) {
    const masterRes = await netFetch(info.master, {
      skipThrottle: true,
      headers: { 'Referer': NET52_BASE + '/', 'Origin': NET52_BASE },
    });
    if (!masterRes.ok) { send(res, masterRes.status, `Upstream master HTTP ${masterRes.status}`); return; }
    const text = await masterRes.text();
    send(res, 200, text, 'application/vnd.apple.mpegurl', { 'Access-Control-Allow-Origin': '*' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    id: info.id,
    title: info.title || title || '',
    image: info.image || '',
    tmdb: tmdbId ? { type, id: tmdbId, season, episode } : undefined,
    net77: {
      playId: info.id,
      seriesId: seriesId || undefined,
      seasonId: seasonId || undefined,
      episodeId: episodeId || undefined,
    },
    master: info.master,
    masterEncoded: info.masterEncoded,
    sources: info.sources,
    audio: info.audio,
    video: info.video,
    subtitles: info.subtitles,
    thumbnails: info.thumbnails,
    tracks: info.tracks,
  });
}

/* -------------------------------------------------------------------------- */
/*  Request handler                                                           */
/* -------------------------------------------------------------------------- */

function handle(req, res) {
  const reqId = randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', reqId);

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = requestUrl.pathname;

  // --- Health -------------------------------------------------------------
  if (req.method === 'GET' && path === HEALTH_PATH) {
    sendJson(res, 200, {
      ok: true,
      service: 'netmirror-hls-resolver',
      envLoaded,
      db: dbEnabled ? 'postgres' : 'memory-only',
      l1: {
        stream: l1Stream.size,
        tmdb: l1Tmdb.size,
        search: l1Search.size,
        idMap: l1IdMap.size,
      },
      activeFetches: activeFetchCount,
      queuedFetches: fetchQueue.length,
      tmdb: TMDB_PROXY ? 'proxy' : (TMDB_API_KEY ? 'api' : 'none'),
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  // --- Slug: /movie/:tmdbId ----------------------------------------------
  const movieMatch = path.match(/^\/movie\/(\d+)\/?$/i);
  if (req.method === 'GET' && movieMatch) {
    const tmdbId = movieMatch[1];
    const force = requestUrl.searchParams.get('force') === '1';
    const raw   = requestUrl.searchParams.get('format') === 'raw';
    resolveSlugId({ type: 'movie', tmdbId }, { force })
      .then(({ net77Id, title }) => respondWithStream(res, net77Id, title, { force, raw, tmdbId, type: 'movie' }))
      .catch((err) => {
        log('error', 'movie slug failed', { reqId, tmdbId, err: err.message });
        sendJson(res, 502, { ok: false, error: err.message });
      });
    return;
  }

  // --- Slug: /tv/:tmdbId/:season/:episode --------------------------------
  const tvMatch = path.match(/^\/tv\/(\d+)\/(\d+)\/(\d+)\/?$/i);
  if (req.method === 'GET' && tvMatch) {
    const tmdbId  = tvMatch[1];
    const season  = Number(tvMatch[2]);
    const episode = Number(tvMatch[3]);
    const force = requestUrl.searchParams.get('force') === '1';
    const raw   = requestUrl.searchParams.get('format') === 'raw';
    resolveSlugId({ type: 'tv', tmdbId, season, episode }, { force })
      .then(({ net77Id, title, seriesId, seasonId, episodeId }) =>
        respondWithStream(res, net77Id, title, { force, raw, tmdbId, type: 'tv', season, episode, seriesId, seasonId, episodeId })
      )
      .catch((err) => {
        log('error', 'tv slug failed', { reqId, tmdbId, season, episode, err: err.message });
        sendJson(res, 502, { ok: false, error: err.message });
      });
    return;
  }

  // --- Direct API by net77 id --------------------------------------------
  if (req.method === 'GET' && path.startsWith(API_PATH + '/')) {
    const id = decodeURIComponent(path.slice(API_PATH.length + 1)).replace(/[^0-9a-z_-]/gi, '');
    if (!id) { send(res, 400, 'Missing id'); return; }
    const force = requestUrl.searchParams.get('force') === '1';
    const raw   = requestUrl.searchParams.get('format') === 'raw';
    respondWithStream(res, id, '', { force, raw }).catch((err) => {
      log('error', 'api resolve failed', { reqId, id, err: err.message });
      sendJson(res, 502, { ok: false, error: err.message });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    return;
  }

  // --- Static / SPA -------------------------------------------------------
  const requestedFile = safeSourcePath(path);
  if (requestedFile && serveStatic(res, requestedFile)) return;
  if (/^\/(?:embed|movie|tv|watch)(?:\/.*)?$/i.test(path) && serveStatic(res, playerFile)) return;

  send(res, 404, 'Not Found');
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                 */
/* -------------------------------------------------------------------------- */

await initDatabase();

const server = createServer((req, res) => {
  try { handle(req, res); }
  catch (err) {
    log('error', 'handler threw', { err: err.stack || err.message });
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
    else res.destroy();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000;
server.maxRequestsPerSocket = 0;

server.listen(PORT, HOST, () => {
  log('info', 'server listening', {
    url: `http://${HOST}:${PORT}`,
    env: envLoaded ? envPath : '(no .env)',
    net77: NET77_BASE,
    net52: NET52_BASE,
    tmdb: TMDB_PROXY ? `proxy ${TMDB_PROXY}` : (TMDB_API_KEY ? 'api.themoviedb.org' : 'MISSING'),
    cookie: NET77_COOKIE ? 'set' : 'MISSING',
    db: dbEnabled ? 'postgres' : 'memory-only',
    maxConcurrent: MAX_CONCURRENT,
  });
});

/* -------------------------------------------------------------------------- */
/*  Graceful shutdown                                                         */
/* -------------------------------------------------------------------------- */

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown initiated', { signal });

  server.close(async (err) => {
    try { if (dbPool) await dbPool.end(); }
    catch (e) { log('warn', 'pg pool close error', { err: e.message }); }
    log(err ? 'error' : 'info', err ? 'close error' : 'closed cleanly', err ? { err: err.message } : {});
    process.exit(err ? 1 : 0);
  });

  setTimeout(() => { log('warn', 'force exit'); process.exit(1); }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log('error', 'unhandledRejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { err: err.stack || err.message });
  shutdown('uncaughtException');
});