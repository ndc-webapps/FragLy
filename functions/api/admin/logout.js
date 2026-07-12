import { clearSessionCookie, json } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
