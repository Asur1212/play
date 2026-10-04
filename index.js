/* ============================================================================
 *  Vidout HLS player server — single-file, production-grade
 *  ---------------------------------------------------------------------------
 *  Endpoints
 *    GET /health                          → liveness probe
 *    GET /master.m3u8                     → dynamically generated HLS master
 *    GET /proxy/stream?url=<encoded>      → header-injecting CDN proxy,
 *                                           transparently rewrites playlists
 *    GET /movie/... /tv/... /embed/...    → SPA fallback to src/index.html
 *    GET /*                               → static files from ./src
 *
 *  Environment
 *    PORT, HOST
 *    STREAM_ID          e.g. 81677444
 *    CDN_ORIGIN         e.g. https://s88.nm-cdn30.top
 *    CDN_PREFIX         e.g. /s24.freecdn3.top/files
 *    VIDEO_TOKEN        e.g. in=95634168...::...::1789898082::ni::p
 *    UPSTREAM_ORIGIN    e.g. https://net52.cc
 *    UPSTREAM_REFERER   e.g. https://net52.cc/
 *    FETCH_TIMEOUT_MS   default 15000
 *    LOG_LEVEL          silent | error | warn | info | debug  (default info)
 * ==========================================================================*/

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const rootDir    = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sourceDir  = join(rootDir, 'src');
const playerFile = join(sourceDir, 'index.html');

const PORT        = Number(process.env.PORT || 3000);
const HOST        = process.env.HOST || '0.0.0.0';
const PROXY_PATH  = '/proxy/stream';
const PROXY_PATH_ANY = '/proxy/any';
const MASTER_PATH = '/master.m3u8';
const HEALTH_PATH = '/health';

const STREAM_ID  = process.env.STREAM_ID  || '81677444';
const CDN_ORIGIN = (process.env.CDN_ORIGIN || 'https://s88.nm-cdn30.top').replace(/\/+$/, '');
const CDN_PREFIX = (process.env.CDN_PREFIX || '/s24.freecdn3.top/files').replace(/\/+$/, '');
const VIDEO_TOKEN = (process.env.VIDEO_TOKEN || '').trim(); // 'in=...' or ''

const UPSTREAM_ORIGIN  = process.env.UPSTREAM_ORIGIN  || 'https://net52.cc';
const UPSTREAM_REFERER = process.env.UPSTREAM_REFERER || 'https://net52.cc/';
const UPSTREAM_UA      = process.env.UPSTREAM_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const LOG_LEVEL        = (process.env.LOG_LEVEL || 'info').toLowerCase();

/* -------------------------------------------------------------------------- */
/*  Logger                                                                    */
/* -------------------------------------------------------------------------- */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const level  = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(lvl, msg, meta) {
  if (LEVELS[lvl] > level) return;
  const ts  = new Date().toISOString();
  const tag = lvl.toUpperCase().padEnd(5);
  const line = meta ? `${ts} ${tag} ${msg} ${JSON.stringify(meta)}` : `${ts} ${tag} ${msg}`;
  (lvl === 'error' ? console.error : console.log)(line);
}

/* -------------------------------------------------------------------------- */
/*  HLS catalogue — drives the dynamic master playlist                        */
/* -------------------------------------------------------------------------- */

/**
 * [language, displayName, index]
 * Indices map to  <CDN>/a/<index>/<index>.m3u8
 */
const AUDIO_TRACKS = [
  ['ara', 'Arabic',             0],
  ['ces', 'Czech',              1],
  ['deu', 'German',             2],
  ['ell', 'Greek',              3],
  ['eng', 'English',            4],
  ['spa', 'Spanish',            5],
  ['spa', 'Spanish',            6],
  ['fil', 'Filipino (Tagalog)', 7],
  ['fra', 'French',             8],
  ['hin', 'Hindi',              9],
  ['hun', 'Hungarian',         10],
  ['ind', 'Indonesian',        11],
  ['ita', 'Italian',           12],
  ['jpn', 'Japanese',          13],
  ['kor', 'Korean',            14],
  ['msa', 'Malay',             15],
  ['nld', 'Dutch',             16],
  ['pol', 'Polish',            17],
  ['por', 'Portuguese',        18],
  ['por', 'Portuguese',        19],
  ['ron', 'Romanian',          20],
  ['rus', 'Russian',           21],
  ['tam', 'Tamil',             22],
  ['tel', 'Telugu',            23],
  ['tha', 'Thai',              24],
  ['tur', 'Turkish',           25],
  ['ukr', 'Ukrainian',         26],
  ['vie', 'Vietnamese',        27],
  ['und', 'Unknown',           28],
];

/**
 * Video variants. `path` is relative to <CDN_ORIGIN><CDN_PREFIX>/<STREAM_ID>/
 * `token` is appended as ?<token> if non-empty (video variants require it,
 * audio tracks don't).
 */
const VIDEO_VARIANTS = [
  { label: 'Full HD', bandwidth: 1000001, resolution: '1920x1080', path: '1080p/1080p.m3u8', isDefault: false },
  { label: 'Mid HD',  bandwidth:  600000, resolution: '1280x720',  path: '720p/720p.m3u8',  isDefault: true  },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES = {
  '.css':   'text/css; charset=utf-8',
  '.gif':   'image/gif',
  '.html':  'text/html; charset=utf-8',
  '.ico':   'image/x-icon',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.map':   'application/json; charset=utf-8',
  '.m3u8':  'application/vnd.apple.mpegurl',
  '.m3u':   'application/vnd.apple.mpegurl',
  '.mp4':   'video/mp4',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.txt':   'text/plain; charset=utf-8',
  '.vtt':   'text/vtt; charset=utf-8',
  '.webp':  'image/webp',
  '.webm':  'video/webm',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
};

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...BASE_SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

function safeSourcePath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = normalize(join(sourceDir, requested));
  return candidate.startsWith(sourceDir + sep) || candidate === sourceDir
    ? candidate
    : null;
}

function serveStatic(res, filePath, { cacheSeconds } = {}) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const ext  = extname(filePath).toLowerCase();
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';
  const isAppShell =
    type.startsWith('text/html') ||
    type.includes('javascript') ||
    type.startsWith('text/css');

  const cacheControl = cacheSeconds != null
    ? `public, max-age=${cacheSeconds}`
    : isAppShell ? 'no-store' : 'public, max-age=3600';

  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    ...BASE_SECURITY_HEADERS,
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function isAllowedStreamUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return false;
    if (h === '::1' || h === '[::1]') return false;
    return true;
  } catch {
    return false;
  }
}

function proxiedUrl(target) {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

/**
 * Rewrite every URI="..." and every bare segment line in an HLS playlist so
 * they all flow back through /proxy/stream. Also normalizes relative paths
 * against the playlist's own URL.
 */
function rewritePlaylist(text, sourceUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line) { out.push(line); continue; }

    // #EXT-X-MEDIA:URI="..."
    const withUris = line.replace(/URI="([^"]+)"/g, (_, uri) => {
      let abs;
      try { abs = new URL(uri, sourceUrl).href; } catch { return `URI="${uri}"`; }
      return `URI="${proxiedUrl(abs)}"`;
    });

    if (withUris.startsWith('#')) { out.push(withUris); continue; }

    // bare URI line — could be a variant playlist or a media segment
    try {
      out.push(proxiedUrl(new URL(withUris, sourceUrl).href));
    } catch {
      out.push(withUris);
    }
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Dynamic master playlist                                                   */
/* -------------------------------------------------------------------------- */

function cdnFile(relPath, token) {
  const base = `${CDN_ORIGIN}${CDN_PREFIX}/${STREAM_ID}/${relPath}`;
  return token ? `${base}?${token}` : base;
}

function buildMasterPlaylist() {
  if (VIDEO_VARIANTS.length && !VIDEO_TOKEN) {
    throw new Error(
      'VIDEO_TOKEN is required to build the master playlist. ' +
      'Set it in the environment (in=...).'
    );
  }

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  // --- Audio renditions -----------------------------------------------------
  for (const [lang, name, idx] of AUDIO_TRACKS) {
    const isDefault = lang === 'eng' && name === 'English';
    const uri = proxiedUrl(cdnFile(`a/${idx}/${idx}.m3u8`, ''));
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="${lang}",` +
      `NAME="${name}",DEFAULT=${isDefault ? 'YES' : 'NO'},URI="${uri}"`
    );
  }

  // --- Video variants -------------------------------------------------------
  for (const v of VIDEO_VARIANTS) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},AUDIO="aac",` +
      `RESOLUTION=${v.resolution},CLOSED-CAPTIONS=NONE` +
      (v.isDefault ? ',DEFAULT=YES' : '')
    );
    lines.push(proxiedUrl(cdnFile(v.path, VIDEO_TOKEN)));
  }

  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/*  CDN proxy                                                                 */
/* -------------------------------------------------------------------------- */

async function proxyStream(req, res, requestUrl, reqId) {
  const target = requestUrl.searchParams.get('url');
  if (!target || !isAllowedStreamUrl(target)) {
    log('warn', 'proxy: rejected url', { reqId, target });
    send(res, 400, 'Unsupported stream URL');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // Propagate client abort to upstream fetch
  const onClientClose = () => controller.abort();
  req.once('aborted', onClientClose);
  req.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    const upstreamHeaders = {
      Origin: UPSTREAM_ORIGIN,
      Referer: UPSTREAM_REFERER,
      'User-Agent': UPSTREAM_UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    // Forward Range so seeking works without buffering the whole segment
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    upstream = await fetch(target, {
      headers: upstreamHeaders,
      cache: 'no-store',
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timeout);
    log('error', 'proxy: upstream fetch failed', { reqId, target, err: err.message });
    send(res, 502, `Stream proxy failed: ${err.message}`);
    return;
  } finally {
    clearTimeout(timeout);
    req.off('aborted', onClientClose);
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const pathname    = (() => { try { return new URL(target).pathname; } catch { return ''; } })();
  const isPlaylist  =
    contentType.includes('mpegurl') ||
    /\.(m3u8|m3u|txt)$/i.test(pathname);

  const outHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': isPlaylist
      ? 'application/vnd.apple.mpegurl'
      : (contentType || 'application/octet-stream'),
  };

  if (upstream.status === 206) {
    // Pass through partial content metadata
    const cr = upstream.headers.get('content-range');
    const ar = upstream.headers.get('accept-ranges');
    if (cr) outHeaders['Content-Range'] = cr;
    if (ar) outHeaders['Accept-Ranges'] = ar;
  } else if (upstream.headers.get('accept-ranges')) {
    outHeaders['Accept-Ranges'] = upstream.headers.get('accept-ranges');
  }
  if (upstream.headers.get('content-length')) {
    outHeaders['Content-Length'] = upstream.headers.get('content-length');
  }

  // Error passthrough
  if (!upstream.ok && upstream.status !== 206) {
    const body = await safeText(upstream);
    log('warn', 'proxy: upstream non-ok', { reqId, status: upstream.status, target });
    if (res.headersSent) return;
    res.writeHead(upstream.status, outHeaders);
    res.end(body);
    return;
  }

  // Playlist: read, rewrite, send
  if (isPlaylist) {
    let text;
    try {
      text = await upstream.text();
    } catch (err) {
      log('error', 'proxy: failed to read playlist body', { reqId, err: err.message });
      send(res, 502, 'Failed to read upstream playlist');
      return;
    }
    const rewritten = rewritePlaylist(text, target);
    if (res.headersSent) return;
    res.writeHead(upstream.status === 206 ? 206 : 200, {
      ...outHeaders,
      'Content-Type': 'application/vnd.apple.mpegurl',
    });
    res.end(rewritten);
    return;
  }

  // Binary segment: stream through
  if (!upstream.body) {
    send(res, 502, 'Upstream returned no body');
    return;
  }
  if (res.headersSent) return;
  res.writeHead(upstream.status === 206 ? 206 : 200, outHeaders);

  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on('error', (err) => {
    log('error', 'proxy: stream error', { reqId, err: err.message });
    if (!res.writableEnded) res.destroy(err);
  });
  res.on('close', () => nodeStream.destroy());
  nodeStream.pipe(res);
}

async function proxyAny(req, res, requestUrl, reqId) {
  const target = requestUrl.searchParams.get('url');
  if (!target || !isAllowedStreamUrl(target)) {
    send(res, 400, 'Unsupported URL');
    return;
  }

  const referer = requestUrl.searchParams.get('referer') || `${UPSTREAM_ORIGIN}/`;
  let origin;
  try { origin = requestUrl.searchParams.get('origin') || new URL(referer).origin; }
  catch { send(res, 400, 'Unsupported referer'); return; }

  const isHead = req.method === 'HEAD';
  const isPlaylist = /\.(m3u8|m3u|txt)(?:\?|$)/i.test(target);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: isHead ? 'HEAD' : 'GET',
      headers: {
        'User-Agent': UPSTREAM_UA,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: referer,
        Origin: origin,
        'Accept-Encoding': 'identity',
        ...(req.headers.range && !isPlaylist ? { Range: req.headers.range } : {})
      },
      redirect: 'follow',
      cache: 'no-store'
    });
  } catch (error) {
    log('error', 'proxyAny upstream failed', { reqId, err: error.message });
    send(res, 502, `Proxy failed: ${error.message}`);
    return;
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    send(res, 404, 'Upstream returned HTML (hotlink protection?)');
    return;
  }
  const outputHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
    'Content-Type': contentType || (isPlaylist ? 'application/vnd.apple.mpegurl' : 'application/octet-stream')
  };
  if (!upstream.ok && upstream.status !== 206) {
    res.writeHead(upstream.status, outputHeaders);
    res.end(isHead ? '' : await safeText(upstream));
    return;
  }
  if (isHead) { res.writeHead(upstream.status, outputHeaders); res.end(); return; }
  if (isPlaylist) {
    const baseQuery = `referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
    const text = await upstream.text();
    const rewritten = text.split(/\r?\n/).map(line => {
      if (!line.trim() || line.trim().startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) =>
          `${'URI="'}${PROXY_PATH_ANY}?url=${encodeURIComponent(new URL(uri, target).href)}&${baseQuery}"`);
      }
      return `${PROXY_PATH_ANY}?url=${encodeURIComponent(new URL(line.trim(), target).href)}&${baseQuery}`;
    }).join('\n');
    res.writeHead(200, { ...outputHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(rewritten);
    return;
  }
  res.writeHead(upstream.status, outputHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function safeText(response) {
  try { return await response.text(); } catch { return ''; }
}

/* -------------------------------------------------------------------------- */
/*  Request handler                                                           */
/* -------------------------------------------------------------------------- */

const SPA_ROUTE = /^\/(?:embed|movie|tv|watch)(?:\/(?:\d+|tt\d+)(?:\/.*)?)?\/?$/i;

function handle(req, res) {
  const reqId = randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', reqId);

  const started = Date.now();
  res.once('finish', () => {
    log('debug', 'req', {
      reqId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Health
  if (req.method === 'GET' && requestUrl.pathname === HEALTH_PATH) {
    send(
      res,
      200,
      JSON.stringify({
        ok: true,
        service: 'vidout-player-server',
        streamId: STREAM_ID,
        videoTokenConfigured: Boolean(VIDEO_TOKEN),
        uptime: Math.round(process.uptime()),
      }),
      'application/json; charset=utf-8'
    );
    return;
  }

  // Dynamic master playlist
  if (req.method === 'GET' && requestUrl.pathname === MASTER_PATH) {
    try {
      const body = buildMasterPlaylist();
      send(res, 200, body, 'application/vnd.apple.mpegurl', {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      log('info', 'master playlist generated', { reqId, bytes: body.length });
    } catch (err) {
      log('error', 'master playlist failed', { reqId, err: err.message });
      send(res, 503, `Master playlist unavailable: ${err.message}`);
    }
    return;
  }

  // CDN proxy
  if (req.method === 'GET' && requestUrl.pathname === PROXY_PATH) {
    proxyStream(req, res, requestUrl, reqId).catch((err) => {
      log('error', 'proxy crashed', { reqId, err: err.stack || err.message });
      if (!res.headersSent) send(res, 500, 'Proxy error');
      else res.destroy();
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && requestUrl.pathname === PROXY_PATH_ANY) {
    proxyAny(req, res, requestUrl, reqId).catch((err) => {
      log('error', 'proxyAny crashed', { reqId, err: err.stack || err.message });
      if (!res.headersSent) send(res, 500, 'Proxy error');
      else res.destroy();
    });
    return;
  }

  // Only GET/HEAD beyond this point
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    return;
  }

  // Static
  const requestedFile = safeSourcePath(requestUrl.pathname);
  if (requestedFile && serveStatic(res, requestedFile)) return;

  // SPA fallback
  if (SPA_ROUTE.test(requestUrl.pathname) && serveStatic(res, playerFile)) return;

  send(res, 404, 'Not Found');
}

/* -------------------------------------------------------------------------- */
/*  Server + graceful shutdown                                                */
/* -------------------------------------------------------------------------- */

const server = createServer((req, res) => {
  try { handle(req, res); }
  catch (err) {
    log('error', 'handler threw', { err: err.stack || err.message });
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
    else res.destroy();
  }
});

server.requestTimeout   = 0;       // streaming
server.headersTimeout   = 20000;
server.keepAliveTimeout = 65000;
server.maxRequestsPerSocket = 0;

server.listen(PORT, HOST, () => {
  log('info', 'server listening', {
    url: `http://${HOST}:${PORT}`,
    streamId: STREAM_ID,
    cdn: `${CDN_ORIGIN}${CDN_PREFIX}/${STREAM_ID}`,
    token: VIDEO_TOKEN ? 'set' : 'MISSING',
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown initiated', { signal });
  server.close((err) => {
    if (err) log('error', 'server close error', { err: err.message });
    else log('info', 'server closed cleanly');
    process.exit(err ? 1 : 0);
  });
  // Hard exit safety net
  setTimeout(() => {
    log('warn', 'force exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { err: err.stack || err.message });
  shutdown('uncaughtException');
});