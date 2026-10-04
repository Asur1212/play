import { createServer } from 'node:http';
import { existsSync, createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sourceDir = join(rootDir, 'src');
const playerFile = join(sourceDir, 'index.html');
const tmdbApiKey = readTmdbApiKey();
const port = Number(process.env.PORT || 4000);
const proxyPath = '/proxy/stream';
const proxyAnyPath = '/api/proxy/any';
const legacyProxyAnyPath = '/proxy/any';
const tmdbApiPath = '/api/tmdb';
const tmdbApiOrigin = 'https://api.themoviedb.org/3';

function readTmdbApiKey() {
  if (process.env.TMDB_API_KEY?.trim()) return process.env.TMDB_API_KEY.trim();

  let envText;
  try {
    envText = readFileSync(join(rootDir, '.env'), 'utf8');
  } catch {
    return '';
  }

  const match = envText.match(/^\s*(?:export\s+)?TMDB_API_KEY\s*=\s*(.*)\s*$/im);
  if (!match) return '';

  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return value;
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.vtt': 'text/vtt; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'frame-ancestors *'
  });
  res.end(body);
}

function sendProxyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type');
}

function safeSourcePath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = normalize(join(sourceDir, requested));
  return candidate.startsWith(sourceDir) ? candidate : null;
}

function serveFile(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const type = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') || type.includes('javascript') || type === 'text/css; charset=utf-8'
      ? 'no-store'
      : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'frame-ancestors *'
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function isAllowedStreamUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return false;
    if (hostname === '::1' || hostname === '[::1]') return false;
    return true;
  } catch {
    return false;
  }
}

function proxiedUrl(url) {
  return `${proxyPath}?url=${encodeURIComponent(url)}`;
}

function resolvePlaylistUrl(uri, sourceUrl) {
  const source = new URL(sourceUrl);
  const hostlessHttpsPath = uri.match(/^https:\/{3,}(.*)$/i);
  if (hostlessHttpsPath) return new URL(`/${hostlessHttpsPath[1]}`, source.origin).href;
  return new URL(uri, sourceUrl).href;
}

function rewritePlaylist(text, sourceUrl) {
  return text.split(/\r?\n/).map(line => {
    const withRewrittenUris = line.replace(/URI="([^"]+)"/g, (_, uri) => {
      const absolute = resolvePlaylistUrl(uri, sourceUrl);
      return `URI="${proxiedUrl(absolute)}"`;
    });

    if (!withRewrittenUris || withRewrittenUris.startsWith('#')) return withRewrittenUris;
    return proxiedUrl(resolvePlaylistUrl(withRewrittenUris, sourceUrl));
  }).join('\n');
}

async function proxyStream(req, res, requestUrl) {
  const target = requestUrl.searchParams.get('url');
  if (!target || !isAllowedStreamUrl(target)) {
    send(res, 400, 'Unsupported stream URL');
    return;
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        Origin: 'https://embed.filmu.in',
        Referer: 'https://embed.filmu.in/'
      },
      cache: 'no-store'
    });

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = contentType.includes('mpegurl') || /\.(m3u8|txt)(?:$|\?)/i.test(new URL(target).pathname);
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : (contentType || 'application/octet-stream')
    };
    sendProxyCors(res);

    if (!upstream.ok) {
      res.writeHead(upstream.status, headers);
      res.end(await upstream.text());
      return;
    }

    if (isPlaylist) {
      res.writeHead(200, headers);
      res.end(rewritePlaylist(await upstream.text(), target));
      return;
    }

    res.writeHead(200, headers);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    send(res, 502, `Stream proxy failed: ${error.message}`);
  }
}

async function proxyAny(req, res, requestUrl) {
  const target = requestUrl.searchParams.get('url');
  if (!target || !isAllowedStreamUrl(target)) {
    send(res, 400, 'Unsupported URL');
    return;
  }

  const referer = requestUrl.searchParams.get('referer') || 'https://vidout.pages.dev/';
  let origin;
  try {
    origin = requestUrl.searchParams.get('origin') || new URL(referer).origin;
  } catch {
    send(res, 400, 'Unsupported referer');
    return;
  }

  const pathname = new URL(target).pathname;
  const isPlaylist = /\.(m3u8|m3u|txt)$/i.test(pathname);
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    Origin: origin,
    'Accept-Encoding': 'identity'
  };
  if (req.headers.range && !isPlaylist) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, redirect: 'follow', cache: 'no-store' });
  } catch (error) {
    send(res, 502, `Proxy failed: ${error.message}`);
    return;
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  sendProxyCors(res);
  const outputHeaders = {
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
    'Content-Type': contentType || (isPlaylist ? 'application/vnd.apple.mpegurl' : 'application/octet-stream')
  };

  if (contentType.includes('text/html')) {
    send(res, 404, 'Upstream returned HTML (hotlink protection?)');
    return;
  }
  if (!upstream.ok) {
    res.writeHead(upstream.status, outputHeaders);
    res.end(req.method === 'HEAD' ? '' : await upstream.text());
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(upstream.status, outputHeaders);
    res.end();
    return;
  }
  if (isPlaylist) {
    const baseQuery = `referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
    const rewritten = (await upstream.text()).split(/\r?\n/).map(line => {
      if (!line.trim() || line.trim().startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) =>
          `URI="${proxyAnyUrl(new URL(uri, target).href, baseQuery)}"`);
      }
      return proxyAnyUrl(new URL(line.trim(), target).href, baseQuery);
    }).join('\n');
    res.writeHead(200, { ...outputHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(rewritten);
    return;
  }
  res.writeHead(upstream.status, outputHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function proxyTmdb(res, requestUrl) {
  const path = requestUrl.pathname.slice(tmdbApiPath.length);
  const allowedPath = /^\/(?:find\/tt\d+|movie\/\d+(?:\/external_ids)?|tv\/\d+(?:\/external_ids|\/season\/\d+(?:\/episode\/\d+)?)?)$/i;
  if (!allowedPath.test(path)) {
    send(res, 400, JSON.stringify({ error: 'Unsupported TMDB path' }), 'application/json; charset=utf-8');
    return;
  }
  if (!tmdbApiKey) {
    send(res, 503, JSON.stringify({ error: 'TMDB_API_KEY is not configured' }), 'application/json; charset=utf-8');
    return;
  }

  try {
    const upstreamUrl = new URL(path.slice(1), `${tmdbApiOrigin}/`);
    for (const [name, value] of requestUrl.searchParams) {
      if (name !== 'api_key') upstreamUrl.searchParams.set(name, value);
    }
    upstreamUrl.searchParams.set('api_key', tmdbApiKey);

    let upstream;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        upstream = await fetch(upstreamUrl, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; VidoutPlayer/1.0)'
          },
          cache: 'no-store'
        });
        if (upstream.status < 500 || attempt === 2) break;
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
    if (!upstream) throw lastError || new Error('TMDB request failed');
    const body = await upstream.text();
    send(
      res,
      upstream.status,
      body,
      upstream.headers.get('content-type') || 'application/json; charset=utf-8'
    );
  } catch (error) {
    send(res, 502, JSON.stringify({ error: `TMDB request failed: ${error.message}` }), 'application/json; charset=utf-8');
  }
}

function proxyAnyUrl(target, baseQuery) {
  return `${proxyAnyPath}?url=${encodeURIComponent(target)}&${baseQuery}`;
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, service: 'vidout-player-server' }), 'application/json; charset=utf-8');
    return;
  }

  if (requestUrl.pathname === proxyPath && req.method === 'OPTIONS') {
    sendProxyCors(res);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if ((requestUrl.pathname === proxyAnyPath || requestUrl.pathname === legacyProxyAnyPath) && req.method === 'OPTIONS') {
    sendProxyCors(res);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === proxyPath) {
    proxyStream(req, res, requestUrl);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (requestUrl.pathname === proxyAnyPath || requestUrl.pathname === legacyProxyAnyPath)) {
    proxyAny(req, res, requestUrl);
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith(`${tmdbApiPath}/`)) {
    proxyTmdb(res, requestUrl);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  const requestedFile = safeSourcePath(requestUrl.pathname);
  if (requestedFile && serveFile(res, requestedFile)) return;

  // The test route accepts either /testurl?url=<master> or the compact
  // /testurl=<master> form used by quick playback checks.
  const isTestUrlRoute = /^\/testurl(?:=.*)?$/i.test(requestUrl.pathname);
  if (isTestUrlRoute && serveFile(res, playerFile)) return;

  // The player uses browser history for /movie/... and /tv/... episode URLs.
  // Send those routes back to the same document so refresh/deep links work.
  const isPlayerRoute = /^\/(embed|movie|tv)(?:\/(?:\d+|tt\d+)(?:\/.*)?)?$/i.test(requestUrl.pathname);
  if (isPlayerRoute && serveFile(res, playerFile)) return;

  send(res, 404, 'Not Found');
});

server.listen(port, () => {
  console.log(`Vidout player server listening on http://localhost:${port}`);
});
