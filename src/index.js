/**
 * Mehfil relay — Cloudflare Worker
 *
 * Provides a store-and-forward relay for Mehfil workspaces. Envelopes
 * (opaque msgpack blobs) are stored in a KV namespace and returned to
 * clients on demand. No content is inspected — the Worker is transport-
 * only; all encryption and signing happens client-side.
 *
 * Endpoints
 * ─────────
 *   PUT  /ws/:ws_id/envelopes         Store one envelope (binary body)
 *   GET  /ws/:ws_id/envelopes         Fetch envelopes since a cursor
 *     ?since=<cursor>&limit=<n>
 *   GET  /ws/:ws_id/cursor            Current write cursor
 *   POST /pairing                     Store an encrypted pairing payload
 *   GET  /pairing/:code_hash          Retrieve + burn a pairing payload
 *   GET  /health                      Liveness check
 *
 * Auth
 * ────
 * Every request (except GET /pairing/:code and GET /health) must carry:
 *   Authorization: Bearer <AUTH_TOKEN>
 * Set AUTH_TOKEN via: wrangler secret put AUTH_TOKEN
 * If AUTH_TOKEN is not set in env, the relay is open (dev mode).
 *
 * KV key schema
 * ─────────────
 *   e/{ws_id}/{ts16}_{rand4}    envelope body (binary, 90-day TTL)
 *   c/{ws_id}                   latest cursor string
 *   p/{code_hash}               pairing entry JSON (5-min TTL, single-use)
 *   rl/{ip}/{minute_epoch}      rate-limit counter (2-min TTL)
 *
 * Cursor format: "{ts16}_{rand4}" — lexicographically sortable, opaque to client.
 */

export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (e) {
      console.error("Unhandled error:", e);
      return jsonResp({ error: "Internal error" }, 500);
    }
  }
};

// ─── Router ──────────────────────────────────────────────────────────────────

async function router(request, env) {
  const { method } = request;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight — allow all origins (end-to-end encrypted, origin doesn't matter).
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Health — no auth.
  if (path === "/health" && method === "GET") {
    return jsonResp({ ok: true, ts: Date.now() });
  }

  // Pairing fetch — no auth (code hash IS the secret).
  let m;
  if ((m = path.match(/^\/pairing\/([A-Za-z0-9_-]{6,128})$/)) && method === "GET") {
    return getPairing(env, m[1]);
  }

  // All other endpoints require auth.
  if (!checkAuth(request, env)) {
    return jsonResp({ error: "Unauthorized" }, 401);
  }

  if ((m = path.match(/^\/ws\/([^/]{1,128})\/envelopes$/))) {
    if (method === "PUT") return putEnvelope(request, env, m[1]);
    if (method === "GET") return getEnvelopes(env, url, m[1]);
  }
  if ((m = path.match(/^\/ws\/([^/]{1,128})\/cursor$/)) && method === "GET") {
    return getCursor(env, m[1]);
  }
  if (path === "/pairing" && method === "POST") {
    return postPairing(request, env);
  }

  return jsonResp({ error: "Not found" }, 404);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function checkAuth(request, env) {
  if (!env.AUTH_TOKEN) return true; // open mode — dev/testing only
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return timingSafeEqual(token, env.AUTH_TOKEN);
}

/** Constant-time string compare to resist timing attacks. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Envelope endpoints ───────────────────────────────────────────────────────

/** PUT /ws/:ws_id/envelopes — store one msgpack envelope. */
async function putEnvelope(request, env, wsId) {
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return jsonResp({ error: "Empty body" }, 400);
  if (body.byteLength > 1_048_576) return jsonResp({ error: "Envelope too large (max 1 MB)" }, 413);

  // Derive a monotonically-increasing, lexicographically-sortable key.
  const ts   = Date.now().toString().padStart(16, "0");
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const seq  = `${ts}_${rand}`;
  const key  = `e/${wsId}/${seq}`;

  // 90-day TTL — old envelopes expire automatically, no housekeeping needed.
  await env.KV.put(key, body, { expirationTtl: 90 * 86_400 });
  // Advance the workspace cursor (cheap metadata write).
  await env.KV.put(`c/${wsId}`, seq, { expirationTtl: 90 * 86_400 });

  return new Response(null, { status: 204, headers: corsHeaders() });
}

/**
 * GET /ws/:ws_id/envelopes?since=<cursor>&limit=<n>
 * Returns [{seq, data: base64}] in ascending order.
 * Clients advance their local cursor to the last returned seq.
 */
async function getEnvelopes(env, url, wsId) {
  const since = url.searchParams.get("since") || "";
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10), 1), 500);

  const listOpts = { prefix: `e/${wsId}/`, limit };
  // startAfter is exclusive — the client's cursor was the last seq it saw.
  if (since) listOpts.startAfter = `e/${wsId}/${since}`;

  const listed = await env.KV.list(listOpts);

  // Fetch values in parallel (KV reads are fast within the same datacenter).
  const results = await Promise.all(
    listed.keys.map(async ({ name }) => {
      const buf = await env.KV.get(name, { type: "arrayBuffer" });
      if (!buf) return null;
      return { seq: name.slice(`e/${wsId}/`.length), data: arrayBufferToBase64(buf) };
    })
  );

  return jsonResp(results.filter(Boolean));
}

/** GET /ws/:ws_id/cursor — returns the latest seq so a client can fast-forward. */
async function getCursor(env, wsId) {
  const cursor = await env.KV.get(`c/${wsId}`, "text");
  return jsonResp({ cursor: cursor || "" });
}

// ─── Pairing endpoints ────────────────────────────────────────────────────────

/**
 * POST /pairing
 * Body JSON: { code_hash: string, payload: string (base64), ttl_ms?: number }
 *   code_hash — SHA-256 of the 6-word code, hex-encoded
 *   payload   — AES-GCM-encrypted workspace invite, base64url
 *   ttl_ms    — optional 1–600 000 ms; default 300 000 (5 min)
 *
 * Rate limited: max 10 posts per IP per minute.
 */
async function postPairing(request, env) {
  // IP-based rate limiting.
  const ip  = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const win = Math.floor(Date.now() / 60_000);
  const rlKey = `rl/${ip}/${win}`;
  const count = parseInt(await env.KV.get(rlKey, "text") || "0", 10);
  if (count >= 10) return jsonResp({ error: "Rate limited — try again in a minute" }, 429);
  await env.KV.put(rlKey, String(count + 1), { expirationTtl: 120 });

  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: "Invalid JSON" }, 400); }
  const { code_hash, payload, ttl_ms } = body;
  if (!code_hash || typeof code_hash !== "string" || !/^[0-9a-f]{64}$/.test(code_hash)) {
    return jsonResp({ error: "Invalid code_hash — expected 64-char hex SHA-256" }, 400);
  }
  if (!payload || typeof payload !== "string") {
    return jsonResp({ error: "Missing payload" }, 400);
  }
  const ttl = Math.min(Math.max(Number(ttl_ms) || 300_000, 60_000), 600_000);

  await env.KV.put(
    `p/${code_hash}`,
    JSON.stringify({ payload, created_at: Date.now() }),
    { expirationTtl: Math.ceil(ttl / 1000) }
  );

  return new Response(null, { status: 204, headers: corsHeaders() });
}

/**
 * GET /pairing/:code_hash
 * Returns { payload } and immediately deletes the entry (single-use).
 * 404 if the code has expired or was already retrieved.
 */
async function getPairing(env, codeHash) {
  if (!/^[0-9a-f]{64}$/.test(codeHash)) {
    return jsonResp({ error: "Invalid code_hash format" }, 400);
  }
  const raw = await env.KV.get(`p/${codeHash}`, "text");
  if (!raw) return jsonResp({ error: "Pairing code not found or already used" }, 404);

  let entry;
  try { entry = JSON.parse(raw); } catch { return jsonResp({ error: "Corrupt entry" }, 500); }

  // Burn it — single-use semantics.
  await env.KV.delete(`p/${codeHash}`);

  return jsonResp({ payload: entry.payload });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function arrayBufferToBase64(buf) {
  // btoa is available in Workers runtime.
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
