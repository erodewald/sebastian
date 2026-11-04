# ADR-003: InstallDO is the single token owner and the only path to SmartThings

**Status:** Accepted (2026-11-04). Implemented in M0 (`apps/worker/src/install-do.ts`).

## Context

SmartThings refresh tokens are single-use and rotate on every refresh. If two concurrent refreshes race, one wins and the other burns the install (`invalid_grant` → manual re-auth).

## Decision

- One `InstallDO` per `installedAppId` holds the tokens, encrypted with AES-256-GCM. The key comes from `DATA_KEY` via HKDF, and the AAD is the `installedAppId`.
- Refresh runs inside `ctx.blockConcurrencyWhile`, with a re-check once the lock is held, so concurrent callers share one refresh.
  - The callback **never throws**: an exception inside `blockConcurrencyWhile` resets the object. The outcome is captured and rethrown afterwards (covered by tests).
- The rotated refresh token is written in the same SQL statement as the new access token, followed by `storage.sync()`, before any caller gets the new access token.
- On `invalid_grant` (or a 401 from the token endpoint), the install moves to `NEEDS_REAUTH` and trips a `needs-reauth` breaker. It does not retry. Other errors are treated as transient and leave the state unchanged.
- `stFetch()` is the only way to reach `api.smartthings.com`. It meters every attempt (by category and route), enforces breakers (402 halt, daily allowance, SSE storm), backs off on 429 and refreshes once on 401. `scripts/check-st-fetch.mjs` fails CI if a SmartThings host appears anywhere else.
- OAuth `state` is a signed, single-use nonce with a 10-minute TTL, held on a dedicated `__oauth__` instance (the `installedAppId` isn't known until the code exchange).

## Restore runbook

- D1: Time Travel (30-day point-in-time restore).
- DO tokens: not restorable by design. If they're lost, re-authorize via `/oauth/start`, then `seb apply`.
- `seb resume` clears a 402 halt once the plan or billing issue is resolved.
- `seb destroy --all` (M1) deletes every managed rule.
