// Gedeelde hulpfuncties voor de Worker.

export class Fout extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

export const ip = req => req.headers.get("CF-Connecting-IP") || "lokaal";

// Tellers tegen misbruik staan in D1, niet in KV: KV laat op het gratis plan maar 1000 schrijfacties
// per dag toe (en 1 per seconde per sleutel), wat een klas die samen antwoorden laat verbeteren meteen opgebruikt.
// Eén atomaire upsert per teller, alle tellers van een aanvraag in één D1-batch; de tabel wordt zo nodig
// zelf aangemaakt (staat ook in schema.sql).
const TELLERS_SQL = [
  "CREATE TABLE IF NOT EXISTS tellers (sleutel TEXT PRIMARY KEY, aantal INTEGER NOT NULL, verloopt INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS tellers_verloopt ON tellers (verloopt)"
];
let tellersKlaar = false;

// limits: [[soort, wie, max, venster in seconden], ...]
export async function rateLimits(env, limits) {
  const now = Math.floor(Date.now() / 1000);
  const stmts = () => limits.map(([kind, who, , windowSec]) => {
    const slot = Math.floor(now / windowSec);
    return env.DB.prepare(
      "INSERT INTO tellers (sleutel, aantal, verloopt) VALUES (?1, 1, ?2) ON CONFLICT(sleutel) DO UPDATE SET aantal = aantal + 1 RETURNING aantal"
    ).bind(`${kind}:${who}:${slot}`, (slot + 1) * windowSec);
  });
  let res;
  try { res = await env.DB.batch(stmts()); }
  catch (e) {
    if (tellersKlaar || !/no such table/i.test(String(e?.message))) throw e;
    await env.DB.batch(TELLERS_SQL.map(q => env.DB.prepare(q)));
    res = await env.DB.batch(stmts());
  }
  tellersKlaar = true;
  // af en toe verlopen tellers opruimen, zonder dat de aanvraag erop wacht
  if (Math.random() < 0.01) env.DB.prepare("DELETE FROM tellers WHERE verloopt < ?1").bind(now).run().catch(() => {});
  res.forEach((r, i) => { if (r.results[0].aantal > limits[i][2]) throw new Fout(429, "Te veel pogingen. Probeer het later opnieuw."); });
}

export const rateLimit = (env, kind, who, max, windowSec) => rateLimits(env, [[kind, who, max, windowSec]]);

export async function getConfig(env) {
  const c = (await env.KV.get("config", "json")) || {};
  return {
    anthropicKey: "", githubToken: "", repo: env.DEFAULT_REPO || "", branch: env.DEFAULT_BRANCH || "main",
    google: { clientId: "", clientSecret: "" },
    microsoft: { clientId: "", clientSecret: "" },
    smartschool: { platform: "", clientId: "", clientSecret: "" },
    ...c
  };
}

export const enc = new TextEncoder();
export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export const mask = s => s ? s.slice(0, 7) + "…" + s.slice(-4) : "";
export const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n);
export const newId = () => Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);

export function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}

/* ---------- Ondertekende tokens (sessies) ---------- */

export async function hmacKey(secretBytes) {
  return crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(key, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + b64url(sig);
}

export async function verifyToken(key, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return p.exp * 1000 > Date.now() ? p : null;
  } catch { return null; }
}

export const bearer = req => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
