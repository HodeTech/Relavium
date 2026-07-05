import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema, type GlobalConfig } from '@relavium/shared';
import { stringify as stringifyToml } from 'smol-toml';

import { ConfigError } from './errors.js';
import { loadConfigFile } from './load.js';
import { ensureGlobalConfigDir, globalConfigDir } from './paths.js';

/**
 * The **first on-disk config WRITER** ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md)) —
 * the sibling of the read-only [load.ts](./load.ts). It persists a user's chosen chat default model to the
 * **global** `~/.relavium/config.toml` `[preferences].default_model`, the write target for `/models` and the
 * onboarding wizard.
 *
 * Three load-bearing guarantees (the ADR-0063 contract; a security-reviewed surface):
 * 1. **Secret-free by construction.** The surface is a **typed setter** ({@link writeGlobalDefaultModel}) — never
 *    a generic `writeKey(k, v)` — so it can only ever set `default_model` (a non-secret). There is no API-key
 *    field in the schema to write to (keys live only in the OS keychain, ADR-0006).
 * 2. **Atomic + owner-only.** It writes a temp file created `0600` in the owner-only (`0700`) `~/.relavium/`
 *    directory, `fsync`s it, then `rename`s over the target — an interrupted write leaves the original intact.
 * 3. **Schema round-trip.** It merges onto the *validated* existing config and re-validates the whole object
 *    against the strict {@link GlobalConfigSchema} (ADR-0033) BEFORE emitting, so the written file is guaranteed
 *    to re-parse cleanly on the next load. `smol-toml.stringify` re-serializes (dropping comments/ordering — the
 *    documented ADR-0063 tradeoff for the global file); no new dependency (`smol-toml` is the ADR-0048 parser).
 */

/**
 * Set the global `[preferences].default_model`, preserving every other config key. Reads + validates the existing
 * `~/.relavium/config.toml` (an absent file ⇒ a fresh `{}`; a **malformed/invalid** existing config throws a
 * {@link ConfigError} rather than clobbering a file the user must fix), merges only `default_model`, re-validates,
 * and writes atomically. `home` is injectable for tests.
 */
export function writeGlobalDefaultModel(model: string, home: string = homedir()): void {
  const dir = ensureGlobalConfigDir(home); // `~/.relavium/` (created `0700`)
  const target = join(dir, 'config.toml');

  // Read the EXISTING config through the same validating loader (so we merge onto known-good data and preserve
  // update_channel / mcp_servers / preferences.theme). An absent file is a fresh object; an invalid one throws.
  const existing = loadConfigFile<GlobalConfig>(target, GlobalConfigSchema) ?? {};
  const next: GlobalConfig = {
    ...existing,
    preferences: { ...existing.preferences, default_model: model },
  };
  // Re-validate the whole object so the emission is provably schema-valid (ADR-0033) — a `.strict()` round-trip
  // that also structurally guarantees no non-schema (e.g. secret) key can reach disk.
  const validated = GlobalConfigSchema.parse(next);
  writeFileAtomic(dir, target, stringifyToml(validated));
}

/**
 * Atomic file replace: write `text` to a unique temp in the SAME (`0700`) directory (so `rename` is atomic and
 * on the same filesystem), explicitly `0600` (never relying on an inherited directory mode — `ensureGlobalConfigDir`
 * `0700`s `~/.relavium/` itself, not necessarily its children), `fsync` for durability, then `rename` over the
 * target. On any failure the temp is best-effort removed and a typed {@link ConfigError} is thrown.
 */
function writeFileAtomic(dir: string, target: string, text: string): void {
  const tmp = join(dir, `config.toml.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600); // `wx`: fail if it exists (the uuid makes a collision impossible)
    writeFileSync(fd, text, 'utf8');
    fchmodSync(fd, 0o600); // owner-only, independent of umask
    fsyncSync(fd); // the temp is durably on disk before the rename
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already failing — ignore a secondary close error */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup (it may never have been created) */
    }
    throw new ConfigError(target, 'could not be written', { cause: err });
  }
}

/** The global config path — exported for tests / callers that need to assert the write target. */
export function globalConfigPath(home: string = homedir()): string {
  return join(globalConfigDir(home), 'config.toml');
}
