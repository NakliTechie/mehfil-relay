# Mehfil relay — Cloudflare Worker

Store-and-forward relay for [Mehfil](https://github.com/NakliTechie/Mehfil).
Runs on Cloudflare's free tier for small teams; scales automatically.

End-to-end encrypted — the Worker only sees opaque ciphertext blobs.
No logs, no analytics, no content inspection.

---

## What this does

Mehfil normally syncs messages peer-to-peer via WebRTC. When both devices
are online simultaneously that works great, but messages can be missed if
one side is offline. The relay is a store-and-forward buffer:

- Clients **push** every outbound envelope to the relay.
- Clients **poll** the relay for new envelopes they haven't seen yet.
- Envelopes expire automatically after 90 days (KV TTL).

The relay never has the decryption keys. All encryption and signing
happens in the browser before the bytes leave the device.

---

## Prerequisites

- A [Cloudflare account](https://cloudflare.com) (free tier is enough)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v3+

```
npm install -g wrangler
wrangler login
```

---

## Deploy in 5 steps

### 1. Create the KV namespace

```bash
wrangler kv:namespace create MEHFIL_KV
wrangler kv:namespace create MEHFIL_KV --preview
```

Copy the `id` and `preview_id` values into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding    = "KV"
id         = "abc123..."           # ← paste here
preview_id = "def456..."           # ← paste here
```

### 2. Set the auth token

Generate a strong random token (e.g. `openssl rand -hex 32`) and set it:

```bash
wrangler secret put AUTH_TOKEN
# paste your token when prompted
```

> **Keep this token secret.** Everyone in your workspace needs it to send
> and receive messages via the relay. Share it out-of-band (e.g. voice,
> Signal message).

### 3. Deploy

```bash
wrangler deploy
```

The Worker URL will be printed, e.g. `https://mehfil-relay.<your-subdomain>.workers.dev`.

### 4. (Optional) Custom domain

In the Cloudflare dashboard → Workers → your worker → Triggers, add a
custom domain route so you can use `https://relay.yourdomain.com`.

### 5. Add the relay to your Mehfil workspace

In Mehfil: **⚙ Settings → Workspace → Relays → + Add relay**

| Field        | Value                                          |
|--------------|------------------------------------------------|
| Type         | Cloudflare Worker                              |
| URL          | `https://mehfil-relay.<sub>.workers.dev`       |
| Bearer token | the token you set in step 2                    |

Click **Test connection** — you should see `✓ Relay reachable`. Click **Save relay**.

---

## API reference

All endpoints (except `GET /health` and `GET /pairing/:code`) require:

```
Authorization: Bearer <AUTH_TOKEN>
```

### `PUT /ws/:ws_id/envelopes`
Store one envelope. Body: raw msgpack bytes (binary). Max 1 MB.
Returns `204 No Content`.

### `GET /ws/:ws_id/envelopes?since=<cursor>&limit=<n>`
Fetch up to `n` (max 500) envelopes after `cursor`.
Returns JSON array: `[{ seq: string, data: string (base64) }, ...]`.
Empty array if nothing new.

### `GET /ws/:ws_id/cursor`
Get the current write cursor.
Returns JSON: `{ cursor: string }`. Empty string if no envelopes stored yet.

### `POST /pairing`
Store an encrypted pairing payload (for 6-word pairing codes).
Body JSON:
```json
{
  "code_hash": "<64-char hex SHA-256 of the 6-word code>",
  "payload":   "<base64-encoded AES-GCM-encrypted invite blob>",
  "ttl_ms":    300000
}
```
Returns `204`. Rate limited to 10 posts per IP per minute.

### `GET /pairing/:code_hash`
Retrieve and burn a pairing payload. Single-use — deleted immediately on read.
Returns JSON: `{ payload: string }` or `404` if expired/already used.

### `GET /health`
Returns `{ ok: true, ts: <unix_ms> }`.

---

## Cost estimate

Cloudflare free tier includes:
- 100,000 Worker requests/day
- 1 GB KV storage
- 100,000 KV reads/day, 1,000 KV writes/day

A 5-person workspace sending ~50 messages/day uses roughly:
- ~300 Worker requests/day (50 sends + 250 polls across 5 clients)
- ~250 KB/day storage (tiny)

Well within free tier. A 30-person workspace sending 500 messages/day
stays free too. Paid tier ($5/month) unlocks 10M requests/day.

---

## Token rotation

Generate a new token, update the secret, and give all members the new
value. The old token stops working immediately. A grace-period rotation
mechanism (where old tokens stay valid for 24h) is planned for v1.1.

---

## Security notes

- Set `AUTH_TOKEN` via `wrangler secret put` — never commit it to source.
- Envelope contents are end-to-end encrypted (AES-256-GCM) by Mehfil before
  transmission; the relay sees only ciphertext.
- Envelope signatures (Ed25519) are verified client-side by Mehfil; the
  relay performs no verification.
- KV data is encrypted at rest by Cloudflare.
- TLS is enforced by Cloudflare (no option to disable).
