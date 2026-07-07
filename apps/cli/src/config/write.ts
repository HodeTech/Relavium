import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { GlobalConfigSchema, type GlobalConfig, type ReasoningEffort } from '@relavium/shared';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { ZodError } from 'zod';

import { ConfigError } from './errors.js';
import { formatZodError, loadConfigFile } from './load.js';
import { ensureGlobalConfigDir, globalConfigDir } from './paths.js';

/**
 * The **first on-disk config WRITER** ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md)) —
 * the sibling of the read-only [load.ts](./load.ts). It persists a user's chosen chat defaults to the **global**
 * `~/.relavium/config.toml` `[preferences]` block — `default_model` and (ADR-0066 §6) `reasoning_effort` — the
 * write targets for the `/models` picker (model + its effort sub-step) and the onboarding wizard. Every later writer
 * inherits this primitive, so its guarantees are enforced by construction, not by convention.
 *
 * Four load-bearing guarantees (the ADR-0063 contract; a security-reviewed surface):
 * 1. **Secret-free by construction.** The surface is a **typed setter** ({@link writeGlobalPreferences}, of which
 *    {@link writeGlobalDefaultModel} is a thin single-key wrapper) — never a generic `writeKey(k, v)` — so it can
 *    only ever set the two non-secret `[preferences]` keys `default_model` / `reasoning_effort`. There is no API-key
 *    field in the schema to write to (keys live only in the OS keychain, ADR-0006). And a schema-validation
 *    failure on the write path is reported through the **same value-free formatter** the loader uses
 *    ({@link formatZodError}) — never a raw `ZodError`, whose `.message` embeds the received value for several
 *    codes and could reach stderr — so the secret-free-error property survives future schema changes.
 * 2. **Atomic + durable + owner-only.** It writes a temp file created `0600` in the owner-only (`0700`)
 *    `~/.relavium/` directory, `fsync`s it, `rename`s over the target, then `fsync`s the parent directory so the
 *    rename itself is durable — an interrupted write leaves the original intact (never torn) and a completed one
 *    survives a crash.
 * 3. **Verified schema round-trip.** It merges onto the *validated* existing config, re-validates the whole
 *    object against the strict {@link GlobalConfigSchema} (ADR-0033), AND re-parses the emitted TOML text back
 *    through the schema BEFORE the rename — so "the written file re-parses cleanly on the next load" is a
 *    verified guarantee, not a trust-the-serializer assumption. On any failure `config.toml` is never touched.
 * 4. **No new dependency.** `smol-toml` is the ADR-0048 parser/serializer already in use; re-serialization drops
 *    comments/ordering (the documented ADR-0063 tradeoff for the global preference file — project/workspace files
 *    are never written by the tool).
 *
 * Two documented invariants / tradeoffs:
 * - **The error MESSAGE is the enforced value-free surface — not the `cause`.** A failure attaches the raw
 *   `ZodError`/`TomlError` as `cause` (as the sibling loader does) for debuggability. That cause *can* embed the
 *   attempted value, but the enforced surface is the value-free `ConfigError` **message** ({@link formatZodError}
 *   / static strings). No current renderer prints `.cause` — they print `err.stack`, which excludes it — so no
 *   value leaks today. A future verbose renderer MUST NOT dump `.cause` (e.g. `util.inspect(err, { depth: null })`)
 *   without re-establishing the value-free property here (mirrors the S5 `model-refresh.ts` "never read cause"
 *   stance, kept as a documented invariant here rather than dropping the debug-useful cause the loader also keeps).
 * - **Last-writer-wins under concurrent writes.** There is no lock/CAS: two racing invocations each read then
 *   rename, so the later rename silently supersedes the earlier edit (a lost update, never a torn or invalid
 *   file). Accepted for a single-user, rarely-written preference store; a future multi-writer path would need a lock.
 */

/** The typed set of global `[preferences]` a write MAY touch (ADR-0063 · ADR-0066 §6). Only non-secret keys —
 *  the typed setter can never reach an API-key field (there is none in the schema; keys live in the keychain). A
 *  field absent from the object is left UNCHANGED (a partial merge), so a model-only write never clears the effort. */
export interface GlobalPreferenceWrite {
  readonly defaultModel?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * Set one or more global `[preferences]` keys (`default_model` and/or `reasoning_effort`), preserving every other
 * config key. Reads + validates the existing config (an absent file ⇒ a fresh `{}`; a **malformed/invalid** existing
 * config throws a {@link ConfigError} rather than clobbering a file the user must fix), merges only the PROVIDED
 * keys (an absent field is left unchanged), re-validates, verifies the serialized text round-trips, and writes
 * atomically. `home` is injectable for tests.
 *
 * `targetPath` (the CLI `--config` override) writes to that **exact** file — the SAME file `loadResolvedConfig`
 * treats as "global" under `--config` — so a `/models` write, the picker's re-read, and the started chat session
 * all agree on ONE file (2.5.G S7). Absent ⇒ the canonical global `~/.relavium/config.toml` (its dir created
 * `0700`). Every ADR-0063 guarantee holds for either target: the temp lands BESIDE the target for an atomic
 * same-filesystem rename and is `0600` by construction, the schema round-trip runs, and the typed setter stays
 * secret-incapable (config holds no secrets, so an arbitrary `--config` dir's own mode is immaterial at rest).
 */
export function writeGlobalPreferences(
  prefs: GlobalPreferenceWrite,
  home: string = homedir(),
  targetPath?: string,
): void {
  // An all-absent write is a no-op: touch nothing rather than emit an empty `[preferences]` table where none
  // existed. Unreachable from the current callers (each passes ≥1 key), but keeps the typed setter footgun-free.
  if (prefs.defaultModel === undefined && prefs.reasoningEffort === undefined) return;
  let target: string;
  let dir: string;
  if (targetPath === undefined) {
    try {
      dir = ensureGlobalConfigDir(home); // `~/.relavium/` (created `0700`)
    } catch (err) {
      // Keep the module's "every failure is a typed, file-attributed ConfigError" contract even for the
      // directory-create step (e.g. EACCES on a read-only home, ENOSPC) — never let a raw fs Error escape.
      throw new ConfigError(
        globalConfigPath(home),
        'could not be written — its directory could not be created.',
        { cause: err },
      );
    }
    target = join(dir, 'config.toml');
  } else {
    // The explicit `--config` target: write beside it (its dir must exist — loadResolvedConfig already read it).
    target = targetPath;
    dir = dirname(targetPath);
  }

  // Read the EXISTING config through the same validating loader (so we merge onto known-good data and preserve
  // update_channel / mcp_servers / preferences.theme + the OTHER preference). An absent file is a fresh object; an
  // invalid one throws. Only the provided keys override — a model-only write keeps a prior `reasoning_effort`.
  const existing = loadConfigFile<GlobalConfig>(target, GlobalConfigSchema) ?? {};
  const merged: GlobalConfig = {
    ...existing,
    preferences: {
      ...existing.preferences,
      ...(prefs.defaultModel === undefined ? {} : { default_model: prefs.defaultModel }),
      ...(prefs.reasoningEffort === undefined ? {} : { reasoning_effort: prefs.reasoningEffort }),
    },
  };

  // Re-validate the whole object so the emission is provably schema-valid (ADR-0033) — a `.strict()` round-trip
  // that also structurally guarantees no non-schema (e.g. secret) key can reach disk. Uses the value-free
  // failure path so a future schema refinement (e.g. a `.min(1)` on `default_model`) fails LOUDLY without ever
  // echoing the received value.
  const validated = validateForWrite(merged, target);
  const text = stringifyToml(validated);
  // Verify the emitted TEXT re-parses to a schema-valid object BEFORE the atomic rename (ADR-0063 §3) — makes
  // the "always re-parses on next load" guarantee verified, not assumed. On failure config.toml is untouched.
  verifyRoundTrips(text, target);
  writeFileAtomic(dir, target, text);
}

/** Set the global `[preferences].default_model` (the common single-key write) — a thin wrapper over
 *  {@link writeGlobalPreferences}. Kept as the named setter the onboarding wizard + the non-effort callers use. */
export function writeGlobalDefaultModel(
  model: string,
  home: string = homedir(),
  targetPath?: string,
): void {
  writeGlobalPreferences({ defaultModel: model }, home, targetPath);
}

/** Schema-validate the object to write, mapping a failure to the value-free {@link ConfigError} path. */
function validateForWrite(value: GlobalConfig, target: string): GlobalConfig {
  const result = GlobalConfigSchema.safeParse(value);
  if (!result.success) {
    throw configWriteError(target, result.error);
  }
  return result.data;
}

/** Prove the serialized TOML re-parses through the schema (ADR-0063 §3) — else refuse to write. */
function verifyRoundTrips(text: string, target: string): void {
  let reparsed: unknown;
  try {
    reparsed = parseToml(text);
  } catch (err) {
    throw new ConfigError(target, 'could not be written — it serialized to invalid TOML.', {
      cause: err,
    });
  }
  const result = GlobalConfigSchema.safeParse(reparsed);
  if (!result.success) {
    throw configWriteError(target, result.error);
  }
}

/** A write-attributed {@link ConfigError} whose detail is the loader's **value-free** field-path reason. */
function configWriteError(target: string, error: ZodError): ConfigError {
  return new ConfigError(target, `could not be written — ${formatZodError(error)}.`, {
    cause: error,
  });
}

/**
 * Atomic file replace: write `text` to a unique temp in the SAME (`0700`) directory (so `rename` is atomic and
 * on the same filesystem), explicitly `0600` (never relying on an inherited directory mode — `ensureGlobalConfigDir`
 * `0700`s `~/.relavium/` itself, not necessarily its children), `fsync` for data durability, `rename` over the
 * target, then a best-effort parent-directory `fsync` so the rename (the directory-entry swap) is durable too. On
 * any failure the temp is best-effort removed and a typed {@link ConfigError} is thrown.
 *
 * Exported ONLY as a test seam — for the fault-injection test that drives the catch path with a real failing
 * rename (a `target` that is an existing directory ⇒ `EISDIR`), verifying the temp is cleaned up and the fd is
 * not leaked. It is NOT part of the writer's public contract: it is a generic "replace this path with this text"
 * primitive with no schema, so the secret-incapability guarantee is a property of {@link writeGlobalPreferences}
 * (the typed setter), never of this helper. Do not call it to write arbitrary content.
 */
export function writeFileAtomic(dir: string, target: string, text: string): void {
  const tmp = join(dir, `config.toml.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600); // `wx`: fail if it exists (the uuid makes a collision impossible); O_EXCL refuses a symlink
    writeFileSync(fd, text, 'utf8');
    fchmodSync(fd, 0o600); // owner-only, independent of umask
    fsyncSync(fd); // the temp is durably on disk before the rename
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target); // replaces the directory entry — never writes THROUGH a symlink at `target`
    fsyncDir(dir); // best-effort: make the rename itself durable, not just the file's data
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

/**
 * Best-effort `fsync` of a directory so a `rename` into it is durable (POSIX metadata flush). Swallows every
 * error and NEVER throws — the rename has already succeeded, so a failure here (e.g. Windows, where a directory
 * fd cannot be `fsync`'d) only weakens crash-durability of the new value, never correctness. Must not throw, or
 * a post-rename failure would wrongly enter the caller's catch and report a successful write as failed.
 */
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, 'r');
    fsyncSync(dfd);
  } catch {
    /* best-effort durability of the rename — see the doc comment */
  } finally {
    if (dfd !== undefined) {
      try {
        closeSync(dfd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The global config path — exported for tests / callers that need to assert the write target. */
export function globalConfigPath(home: string = homedir()): string {
  return join(globalConfigDir(home), 'config.toml');
}
