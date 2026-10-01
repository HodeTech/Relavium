# Overflow capture tooling

`capture.mjs` is the maintainer runner for ADR-0096's live provider evidence. Its typed
request, deadline and secret-refusal logic lives in `packages/llm/src/adapters/overflow-capture.ts`.
Build `@relavium/llm` first. The canonical procedure, bounds and fixture acceptance are in
[capture-provider-overflow.md](../../docs/runbooks/capture-provider-overflow.md).

`check.mjs` exercises the built command offline through a synthetic fetch preloader. Run
`pnpm smoke:overflow-capture` after the build; `pnpm ci` includes it. Its responses are command
test data, never live provider fixtures.
