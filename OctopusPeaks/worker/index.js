/**
 * Octopus Peaks backend for Cloudflare Workers.
 *
 * Serves the static dashboard and a small read-only proxy to the Octopus Energy API at /octo,
 * so the API key stays here as a secret and never reaches a browser.
 *
 * Every /octo request must carry a valid Cloudflare Access token. If Access is not switched on,
 * or its settings are missing, the proxy refuses to answer rather than exposing the account.
 *
 * Settings (Worker > Settings > Variables and Secrets):
 *   OCTOPUS_API_KEY   secret   sk_live_...
 *   OCTOPUS_ACCOUNT   secret   A-1234ABCD
 *   TEAM_DOMAIN       text     https://<team>.cloudflareaccess.com   (shown when you enable Access)
 *   POLICY_AUD        text     the Access application's AUD tag       (shown when you enable Access)
 *   ALLOWED_EMAILS    text     optional, comma separated; a second check on top of the Access policy
 *
 * Binding (created automatically on first deploy, see wrangler.jsonc):
 *   STORE             KV       holds the appliance names the household has typed in, so every device sees them
 */
const OCTOPUS = "https://api.octopus.energy";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const deny = (error, status = 403) => json({ error }, status);

/* ---------- Cloudflare Access token check (RS256, no dependencies) ---------- */
let jwks = { at: 0, keys: [] };
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
async function accessKeys(teamDomain, force) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not fetch the Cloudflare Access signing keys.");
  jwks = { at: Date.now(), keys: (await res.json()).keys || [] };
  return jwks.keys;
}
async function verifyAccess(request, env) {
  const team = (env.TEAM_DOMAIN || "").replace(/\/+$/, ""), aud = env.POLICY_AUD;
  if (!team || !aud) throw new Error("Cloudflare Access is not configured: TEAM_DOMAIN and POLICY_AUD are missing.");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("No Cloudflare Access token on the request. Switch Access on for this Worker.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Access token.");
  const dec = new TextDecoder(), header = JSON.parse(dec.decode(b64url(parts[0]))), claims = JSON.parse(dec.decode(b64url(parts[1])));
  if (header.alg !== "RS256") throw new Error("Unexpected Access token algorithm.");
  let jwk = (await accessKeys(team)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find(k => k.kid === header.kid); // keys rotate
  if (!jwk) throw new Error("Access token was signed by an unknown key.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("Access token signature is not valid.");
  const now = Date.now() / 1000;
  if (!(claims.exp > now)) throw new Error("Access token has expired.");
  if (claims.nbf && claims.nbf > now + 60) throw new Error("Access token is not valid yet.");
  if (claims.iss !== team) throw new Error("Access token is from a different Cloudflare team.");
  if (![].concat(claims.aud || []).includes(aud)) throw new Error("Access token is for a different application.");
  const allowed = (env.ALLOWED_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(claims.email || "").toLowerCase())) throw new Error("This email address is not on the allowed list.");
  return claims;
}

/* ---------- Octopus ---------- */
let kraken = { at: 0, token: null, key: null };
async function krakenToken(env) {
  if (kraken.token && kraken.key === env.OCTOPUS_API_KEY && Date.now() - kraken.at < 45 * 60e3) return kraken.token;
  const res = await fetch(`${OCTOPUS}/v1/graphql/`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "mutation($k:String!){obtainKrakenToken(input:{APIKey:$k}){token}}", variables: { k: env.OCTOPUS_API_KEY } }) });
  const token = (await res.json())?.data?.obtainKrakenToken?.token;
  if (!token) throw new Error("Octopus did not accept the API key.");
  kraken = { at: Date.now(), token, key: env.OCTOPUS_API_KEY };
  return token;
}
const passthrough = async res => new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function proxy(request, env, url) {
  if (!env.OCTOPUS_API_KEY || !env.OCTOPUS_ACCOUNT) return deny("OCTOPUS_API_KEY and OCTOPUS_ACCOUNT are not set on this Worker.", 500);
  try { await verifyAccess(request, env); } catch (e) { return deny(e.message); }

  if (request.method === "GET" && url.searchParams.has("config")) return json({ ok: true, account: env.OCTOPUS_ACCOUNT });

  // Shared appliance names: one small document, read and replaced whole.
  if (url.searchParams.has("names")) {
    if (!env.STORE) return deny("No STORE binding on this Worker, so names cannot be shared.", 501);
    if (request.method === "GET") return json((await env.STORE.get("names", "json")) || { labels: [], appliances: [] });
    if (request.method !== "POST") return deny("Method not allowed.", 405);
    let body;
    try { body = await request.json(); } catch (_) { return deny("Body must be JSON.", 400); }
    const clean = list => Array.isArray(list) && list.length <= 100 && list.every(x => x && typeof x.name === "string" && x.name.length >= 1 && x.name.length <= 60 && Number.isFinite(x.w) && x.w > 0 && x.w < 30000)
      ? list.map(x => ({ w: Math.round(x.w), name: x.name.trim() })) : null;
    const doc = { labels: clean(body?.labels), appliances: clean(body?.appliances) };
    if (!doc.labels || !doc.appliances) return deny("Names must be lists of { w, name }.", 400);
    await env.STORE.put("names", JSON.stringify(doc));
    return json(doc);
  }

  if (request.method === "GET") {
    // Read-only REST: only paths under /v1/, nothing that climbs out of it.
    const target = url.searchParams.get("u") || "";
    if (!target.startsWith("/v1/") || target.includes("..") || target.includes("//") || /[\s\\@]/.test(target)) return deny("Path not allowed.", 400);
    return passthrough(await fetch(OCTOPUS + target, { headers: { Authorization: "Basic " + btoa(env.OCTOPUS_API_KEY + ":"), Accept: "application/json" } }));
  }

  if (request.method === "POST") {
    // Read-only GraphQL: queries only, never mutations.
    let body;
    try { body = await request.json(); } catch (_) { return deny("Body must be JSON.", 400); }
    const query = String(body?.query || "").replace(/#[^\n]*/g, "").trim();
    if (!/^(query\b|\{)/.test(query) || /\b(mutation|subscription)\b/.test(query)) return deny("Only queries are allowed.", 400);
    const send = async () => fetch(`${OCTOPUS}/v1/graphql/`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: await krakenToken(env) }, body: JSON.stringify({ query: body.query, variables: body.variables || {} }) });
    try {
      let res = await send(), text = await res.text();
      if (/KT-CT-1124|JWT.*expired/i.test(text)) { kraken.token = null; res = await send(); text = await res.text(); }
      return new Response(text, { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch (e) { return deny(e.message, 502); }
  }
  return deny("Method not allowed.", 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/octo") return proxy(request, env, url);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};
