const HENRIK_API_KEY = process.env.HENRIK_API_KEY || process.env.HDEV_API_KEY || '';
const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const rawPath = req.query?.path;
  const path = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
  if (!path || path.includes('..')) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Invalid HenrikDev path' }));
  }

  const incoming = new URL(req.url, 'https://fragly.local');
  const upstream = new URL(`${HENRIK_BASE}/${path}`);
  incoming.searchParams.forEach((value, key) => {
    if (key !== 'path') upstream.searchParams.append(key, value);
  });

  const headers = {};
  if (HENRIK_API_KEY) headers.Authorization = HENRIK_API_KEY;

  try {
    const r = await fetch(upstream, { headers });
    const body = await r.text();
    res.statusCode = r.status;
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(body);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'HenrikDev upstream unavailable' }));
  }
};
