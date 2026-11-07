# ADR-002: Automations as code; client-side compile; private `home` repo; GitOps

> Amended by ADR-006 (2026-11-06): the web UI can also write automations, kept per location in D1; compiling is still client-side.

**Status:** Accepted (2026-11-04)

## Decision

- Automations are typed TypeScript (one file per rule) in a private `home` repo, written in a DSL that maps 1:1 onto the Rules API grammar.
- The `seb` CLI compiles DSL → `RuleRequest` JSON **client-side** (laptop or CI). It sends compiled JSON plus source hashes to `/api/plan` and `/api/apply`. The Worker never executes user code.
- A PR to `home` gets a `seb plan` comment; a merge to `main` runs `seb apply`. CI authenticates with an Access service token and never holds SmartThings credentials.
- This repo (`sebastian`) is built only from public docs and can be public. Device IDs live only in `home`.

## Consequences

- The deployed service stays small and generic, with a smaller attack surface.
- Compiler and linter versions move with the CLI, so `plan` output depends on the CLI version. Record the compiler version with each apply.
