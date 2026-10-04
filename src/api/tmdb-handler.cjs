const TMDB_API_ORIGIN = 'https://api.themoviedb.org/3';
const ALLOWED_PATH = /^\/(?:find\/tt\d+|movie\/\d+(?:\/external_ids)?|tv\/\d+(?:\/external_ids|\/season\/\d+(?:\/episode\/\d+)?)?)$/i;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

module.exports = async function tmdb(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const path = requestUrl.pathname.slice('/api/tmdb'.length);
  if (!ALLOWED_PATH.test(path)) {
    sendJson(res, 400, { error: 'Unsupported TMDB path' });
    return;
  }

  const apiKey = process.env.TMDB_API_KEY?.trim();
  if (!apiKey) {
    sendJson(res, 503, { error: 'TMDB_API_KEY is not configured' });
    return;
  }

  const upstreamUrl = new URL(path.slice(1), `${TMDB_API_ORIGIN}/`);
  for (const [name, value] of requestUrl.searchParams) {
    if (name !== 'api_key') upstreamUrl.searchParams.set(name, value);
  }
  upstreamUrl.searchParams.set('api_key', apiKey);

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; VidoutPlayer/1.0)'
      },
      cache: 'no-store'
    });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.end(await upstream.text());
  } catch (error) {
    sendJson(res, 502, { error: `TMDB request failed: ${error.message}` });
  }
};