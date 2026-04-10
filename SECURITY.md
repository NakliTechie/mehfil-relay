# Security

## Threat model

The Mehfil relay is a store-and-forward transport. It never holds encryption keys or decrypts envelopes — all cryptographic operations happen client-side. The relay sees only padded ciphertext addressed to a workspace ID.

The relay does **not** protect against:

- **Token theft** — anyone with the bearer token can write ciphertext to the relay. They cannot decrypt it (no keys), but they can flood it with garbage envelopes, which recipients will drop on signature verification failure.
- **Traffic analysis** — a relay operator can observe message timing, frequency, and approximate size (envelopes are padded to 1 KB but counts and timestamps are visible).
- **KV namespace exhaustion** — a token holder could write many envelopes. Envelopes expire after 90 days; the 4 KB per-envelope cap limits the cost per write.

## Auth

Every write endpoint requires `Authorization: Bearer <AUTH_TOKEN>`. The token is set via `wrangler secret put AUTH_TOKEN` and never appears in source. If `AUTH_TOKEN` is not configured the relay runs in open mode — **do not deploy without setting the token**.

Pairing code retrieval (`GET /pairing/:code_hash`) does not require the bearer token; the SHA-256 code hash is the secret. Pairing entries are single-use and expire after 5 minutes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Reach out on Twitter at [@chirag](https://twitter.com/chirag). Include a description of the vulnerability, steps to reproduce, and your assessment of severity. I aim to respond within 72 hours.
