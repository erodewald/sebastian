# ADR-006: Write, plan and apply automations in the web UI

**Status:** accepted 2026-11-06 · **Amends:** ADR-002 (the home repo is no longer the only source)

## Context

ADR-002 made a private git repo the place automations live: `seb plan/apply` compiles them on
your machine and the Worker never runs automation code. The owner wants to write and deploy
automations from the web UI too, and evaluators (ADR-005) won't have a home repo.

## Decision

- **Each location has a workspace** of automation sources in D1 (`automations` table): its
  desired state. It starts from the sources of the rules already deployed. The web editor saves
  to it (autosave), and every apply (web or CLI) makes it exactly what was applied, so the CLI and
  the web never disagree for long. `seb export` writes the workspace to `automations/` so git can
  keep history.
- **Compiling stays client-side.** The browser compiles with the same DSL, codegen and compiler
  packages the CLI uses: sucrase strips the TypeScript, the module runs against the real DSL and
  device handles generated from the location's model, and the compiler emits Rules JSON. The
  Worker still never runs automation code; it gets the same `PlanItem`s it gets from the CLI.
- **Compiling runs in a sandbox.** With several people per location, opening an automation
  means running code someone else wrote. It runs in an iframe with `sandbox="allow-scripts"`
  (opaque origin: no cookies, no Access session) and a CSP of `default-src 'none'` (no network).
  The page and the sandbox talk only through `postMessage`, so the code can't act as whoever
  opened it.
- **The model is cached** per location (`model_cache`). The editor reads the cache; a refresh
  (`?refresh=1`, what `seb pull` sends) needs editor because it spends SmartThings calls.
- **Values are checked at runtime.** Neither `seb plan` nor the browser type-checks, so the DSL
  now rejects unknown enum values, numeric comparisons on non-numbers, and misspelled
  capabilities or attributes, naming what exists.

## Consequences

- Editing in the web and in a home repo at the same time means the last apply wins. `seb export`
  brings web edits into the repo.
- The editor chunk (CodeMirror plus the sandbox bundle) is about 250 KB gzipped and loads only
  when the Code tab is opened.
