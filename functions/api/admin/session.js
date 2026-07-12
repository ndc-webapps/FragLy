// GET -> { authed: true|false }. Lets the admin page know whether to show the
// login form or the ad manager without guessing from a fetch(/api/ads) error.
import { isAuthed, json } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  return json({ authed: await isAuthed(context) });
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
