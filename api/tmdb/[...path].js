const TMDB_API_ORIGIN = 'https://api.themoviedb.org/3';
const TMDB_API_PATH = '/api/tmdb';
const ALLOWED_PATH = /^\/(?:find\/tt\d+|movie\/\d+(?:\/external_ids)?|tv\/\d+(?:\/external_ids|\/season\/\d+(?:\/episode\/\d+)?)?)$/i;

export default async function tmdb(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const path = requestUrl.pathname.slice(TMDB_API_PATH.length);
  if (!ALLOWED_PATH.test(path)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Unsupported TMDB path' }));
    return;
  }

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'TMDB_API_KEY is not configured' }));
    return;
  }

  try {
    const upstreamUrl = new URL(path.slice(1), `${TMDB_API_ORIGIN}/`);
    for (const [name, value] of requestUrl.searchParams) {
      if (name !== 'api_key') upstreamUrl.searchParams.set(name, value);
    }
    upstreamUrl.searchParams.set('api_key', apiKey);

    let upstream;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        upstream = await fetch(upstreamUrl, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible: VidoutPlayer/1.0)'
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
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.end(await upstream.text());
  } catch (error) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: `TMDB request failed: ${error.message}` }));
  }
}