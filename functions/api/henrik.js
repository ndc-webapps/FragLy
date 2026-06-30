const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';

export async function onRequestGet(context) {
  const { request, env } = context;
  const HENRIK_API_KEY = env.HENRIK_API_KEY || env.HDEV_API_KEY || '';

  const incoming = new URL(request.url);
  const path = String(incoming.searchParams.get('path') || '').replace(/^\/+/, '');
  if (!path || path.includes('..')) {
    return new Response(JSON.stringify({ error: 'Invalid HenrikDev path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const upstream = new URL(`${HENRIK_BASE}/${path}`);
  incoming.searchParams.forEach((value, key) => {
    if (key !== 'path') upstream.searchParams.append(key, value);
  });

  const headers = {};
  if (HENRIK_API_KEY) headers.Authorization = HENRIK_API_KEY;

  try {
    const r = await fetch(upstream, { headers });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'HenrikDev upstream unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return onRequestGet(context);
}
