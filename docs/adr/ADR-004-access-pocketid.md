# ADR-004: Cloudflare Access with PocketID, OTP break-glass and service tokens

**Status:** Accepted (2026-11-04)

## Decision

- One **self-hosted, public-hostname** Access application covers `sebastian.baltar.media/*`, deny by default. It is deliberately _not_ a Worker-destination app: those don't support WebSocket upgrades (needed for StreamDO fan-out to `seb tail` and the UI), and they need the Worker to exist before the app does. Policies:
  - your PocketID identity (generic OIDC; redirect `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`);
  - service tokens `seb-cli` and `seb-ci`;
  - one-time PIN to your email as **break-glass** when the homelab (and therefore PocketID) is down.
- The Worker re-validates `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) on **every** request against the team JWKS, issuer and application AUD. It fails closed (HTTP 500) if `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are unset.
- The SmartThings OAuth callback stays behind Access too. Your browser already holds the Access session when SmartThings redirects back.

## Consequences

- Nothing on the hostname is public, and SmartThings never calls in (no webhooks; see ADR-001).
- A PocketID outage blocks interactive login (R8) but not CI (service tokens) or hub rules.

## Amendment (2026-11-05): lifecycle bypass and Worker destinations

- `/st/lifecycle` (ADR-001 amendment) is served by a second, path-scoped Access app with a **Bypass** policy. Access picks the most specific matching app, so every other path stays on the main app.
- **Neither app may use a Workers destination.** A Workers destination applies to the whole Worker regardless of hostname or path. Adding one to the bypass app silently made all of `/api/*` reach the Worker without an Access JWT. The Worker's own check refused those requests (401), which is exactly the defense in depth this ADR asked for.
- After any Access change, run the two checks in the README (step 7): `/api/status` must redirect to Access, and `/st/lifecycle` must answer a PING.
- Service-token policies must use the **Service Auth** action.
- Bot Fight Mode must be off for the zone (Free plan), or `/st/lifecycle` must be WAF-skipped (Pro and up). Otherwise SmartThings' CONFIRMATION never arrives.
