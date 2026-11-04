# ADR-001: Cloudflare-native hosting; SSE in a Durable Object with a Container fallback; no webhooks

**Status:** Accepted (2026-11-04). Revisit at M2 exit.

## Context

Sebastian is the fail-safe tier next to Home Assistant, so its tooling should survive a homelab outage. The runtime path (hub-local rules) doesn't depend on where the tooling runs. Verify mode needs one long-lived SSE connection to SmartThings.

## Decision

- Host on Cloudflare: Workers (Hono), Durable Objects, D1, Workflows, Access. Other products (Queues, R2, KV, Analytics Engine, AI Gateway, Containers) are added only when PLAN §4 names a trigger.
- Host the SSE consumer in `StreamDO`. A 60 s alarm acts as watchdog and keeps the object resident. Each pending outbound fetch only keeps the object alive for 15 minutes, so the alarm, not the stream, is what holds residency.
- No webhooks: nothing on the hostname accepts inbound calls from SmartThings.

## Consequences

- One always-resident DO is billed around the clock while verify mode is continuous. Windowed verify (`seb verify --for 2h`) avoids that.
- Every deploy or platform restart drops the stream. That counts as an unexpected drop (reconnect, then reconcile via REST); SSE has no replay anyway.
- **Fallback:** if DO-hosted SSE proves flaky in M2 (R4), move only the stream consumer into a Cloudflare Container bound to StreamDO. Nothing else changes.
