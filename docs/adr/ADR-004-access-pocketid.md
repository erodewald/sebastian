# ADR-004: Cloudflare Access with PocketID, OTP break-glass and service tokens

**Status:** Accepted (2026-11-04)

## Decision

- One Access application covers `sebastian.baltar.media/*`, deny by default. Policies:
  - your PocketID identity (generic OIDC; redirect `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`);
  - service tokens `seb-cli` and `seb-ci`;
  - one-time PIN to your email as **break-glass** when the homelab (and therefore PocketID) is down.
- The Worker re-validates `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) on **every** request against the team JWKS, issuer and application AUD. It fails closed (HTTP 500) if `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are unset.
- The SmartThings OAuth callback stays behind Access too. Your browser already holds the Access session when SmartThings redirects back.

## Consequences

- Nothing on the hostname is public, and SmartThings never calls in (no webhooks; see ADR-001).
- A PocketID outage blocks interactive login (R8) but not CI (service tokens) or hub rules.
