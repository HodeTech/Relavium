# Installed CLI behavior smoke

`runInstalledSmoke({ packageRoot, supportRoot, artifactSha256, source })` from
[index.mjs](index.mjs) tests the actual installed `relavium` package. The caller
inspects and installs the exact tarball first, binds its digest/source identity,
and supplies absolute paths. This runner never builds, packs, installs or rewrites
product files. `supportRoot/installed-smoke.json` contains bounded structured
results; the runner removes its owned temporary HOME/workspaces after joining
children. Every compiled JS digest must remain unchanged.

[cases.mjs](cases.mjs) is the fixed required case inventory, shared with the
aggregate. Each result has `id`, `passed`, and evidence or an error. Overall
`success` requires the complete inventory and unchanged compiled bytes.

- Load the actual keyring native addon without constructing `Entry` or calling a
  keychain API; load actual SQLite and execute an in-memory query. Dependency and
  native binary resolution must stay in the installed consumer's `node_modules`.
- Execute installed version and compare it with installed package metadata.
  The surrounding bootstrap controls own exhaustive meta-operation isolation.
- Run the actual transform workflow and installed migrations; discover a paused
  human gate and resume it in a fresh process. Produce a real budget pause, reject
  four invalid decisions without durable mutation, abort and repeat idempotently.
  A documented `agent run --fixture` cassette drives an actual governed write
  denial: no target file, dispatch or effect-journal mutation.
- Drive two actual chat turns through the installed OpenAI SDK, inlined adapter,
  AgentSession, JSON printer and SQLite stores. Hold stdin until assistant output
  and its durable row exist, then `/exit` with code 4. Resume the same session and
  check the second real SDK request carries the first exchange, four ordered
  transcript rows, exact dispatch counts and complete durable usage.
- Spawn a real native stdio MCP fixture after the actual consent refusal/digest
  flow, verify initialize carries the installed CLI version, discover tools, and
  join the native child. No provider/key lookup is needed on this gate-only graph.
- Run the existing parameterized actual media/CAS native cleanup witness against
  the installed entry, including the shared iterator-provenance ownership join.

Chat's key resolver is keychain-first: exactly two synthetic `Entry` constructor
attempts are recorded and refused before native API access. The budget run has one
separately asserted synthetic preflight attempt. All other key/network attempts
are forbidden. The native addon load-only process has no keyring substitute.

The external `--import` preload uses Node's `module.register` API available in
Node 22.0. It replaces only the keyring import and exact synthetic HTTP transport,
not shipped commands, engine code, SDK parsing or persistence. The only admitted
network-shaped data fetch is QuickJS's local WASM data URL; the only admitted
child spawn is the explicit MCP fixture. These are test witnesses, not a claimed
security sandbox. The chat transport admits one exact synthetic OpenAI request
shape and returns complete synthetic SSE. No real credential, provider call or
billing setup is used.

The exact Node 22.0 Linux and current Node 24 Linux/macOS/Windows consumers must
execute this same runner and artifact digest. A local pass cannot substitute for
those required platform legs. Archive inspection, bootstrap/meta controls and
aggregate enforcement belong to the surrounding package runner. Native fatal
integration and original-TS maps/custody retain their later Wave 3 scopes.

Narrow child-lifetime negative controls run with:

```sh
node --test tools/cli-package/smoke/process.test.mjs
```
