// Shared helpers for the /admin ads panel — HMAC-signed session cookies.
// Files under functions/_lib are not routed by Cloudflare Pages (leading underscore),
// so this is safe to import from the actual route handlers.
//
// Requires two env vars set in Cloudflare Pages → Settings → Environment variables:
//   ADMIN_PASSWORD  — the password typed into /admin
//   SESSION_SECRET  — any long random string, used to sign session cookies

const COOKIE_NAME = 'fragly_admin';
const SESSION_TTL_SECONDS = 60 * 60 * 8; // absolute server-side cap on the signed token, independent of the cookie below

function toBase64Url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

// Safe for comparing two values that are ALREADY the same length by construction
// (HMAC digests). The early length return leaks length, which is fine for a digest but
// not for a secret — see passwordMatches() below, which hashes first for that reason.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(env) {
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp })));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

export async function verifySessionToken(env, token) {
  if (!token || !env.SESSION_SECRET || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return typeof exp === 'number' && Date.now() < exp;
  } catch (e) {
    return false;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

export function setSessionCookie(token) {
  // No Max-Age/Expires on purpose: this makes it a true browser-session cookie, which
  // the browser deletes itself once you fully close it (all tabs/windows) — the actual
  // mechanism for "close the browser -> logged out". The token's own exp claim (checked
  // in verifySessionToken) is the server-side backstop if the cookie somehow survives
  // (e.g. a browser's tab-restore feature).
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function isAuthed(context) {
  const { request, env } = context;
  const token = getCookie(request, COOKIE_NAME);
  return verifySessionToken(env, token);
}

// HMACs both sides before comparing so the inputs are always the same length. Comparing
// the raw strings returned early on a length mismatch, which leaked the real password's
// length through response timing. Now async — callers must await.
export async function passwordMatches(env, candidate) {
  const [a, b] = await Promise.all([
    hmac(env.SESSION_SECRET, String(candidate || '')),
    hmac(env.SESSION_SECRET, String(env.ADMIN_PASSWORD || ''))
  ]);
  return timingSafeEqual(a, b);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders }
  });
}
