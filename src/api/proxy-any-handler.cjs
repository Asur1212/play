const { Readable } = require('node:stream');

const PROXY_PATH = '/api/proxy/any';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type');
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return false;
    if (hostname === 'localhost' || hostname.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return false;
    return hostname !== '::1' && hostname !== '[::1]';
  } catch {
    return false;
  }
}

function playlistProxyUrl(target, baseQuery) {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}&${baseQuery}`;
}

function copyRangeHeaders(upstream, res) {
  for (const name of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

module.exports = async function proxyAny(req, res) {
  setCorsHeaders(res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const target = requestUrl.searchParams.get('url');
  if (!target || !isAllowedUrl(target)) {
    res.statusCode = 400;
    res.end('Unsupported URL');
    return;
  }

  const referer = requestUrl.searchParams.get('referer') || 'https://vidout.pages.dev/';
  let origin;
  try {
    origin = requestUrl.searchParams.get('origin') || new URL(referer).origin;
  } catch {
    res.statusCode = 400;
    res.end('Unsupported referer');
    return;
  }

  const targetUrl = new URL(target);
  const isPlaylist = /\.(m3u8|m3u|txt)$/i.test(targetUrl.pathname);
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    Origin: origin,
    'Accept-Encoding': 'identity'
  };
  if (req.headers?.range && !isPlaylist) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      redirect: 'follow',
      cache: 'no-store'
    });
  } catch (error) {
    res.statusCode = 502;
    res.end(`Proxy failed: ${error.message}`);
    return;
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  res.setHeader('Content-Type', contentType || (isPlaylist ? 'application/vnd.apple.mpegurl' : 'application/octet-stream'));
  copyRangeHeaders(upstream, res);

  if (contentType.includes('text/html')) {
    res.statusCode = 404;
    res.end('Upstream returned HTML (hotlink protection?)');
    return;
  }
  if (!upstream.ok) {
    res.statusCode = upstream.status;
    res.end(req.method === 'HEAD' ? '' : await upstream.text());
    return;
  }
  if (req.method === 'HEAD') {
    res.statusCode = upstream.status;
    res.end();
    return;
  }
  if (isPlaylist) {
    const baseQuery = `referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
    const rewritten = (await upstream.text()).split(/\r?\n/).map(line => {
      if (!line.trim() || line.trim().startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) =>
          `URI="${playlistProxyUrl(new URL(uri, targetUrl).href, baseQuery)}"`);
      }
      return playlistProxyUrl(new URL(line.trim(), targetUrl).href, baseQuery);
    }).join('\n');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(rewritten);
    return;
  }

  res.statusCode = upstream.status;
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
};