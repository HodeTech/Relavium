import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  GlobalConfigSchema,
  type GlobalConfig,
  type LlmProviderId,
  type ReasoningEffort,
} from '@relavium/shared';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { ZodError } from 'zod';

import { CliError } from '../process/errors.js';

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
 *    only ever set the three model preferences. Separate closed setters admit the two operator-state fields.
 *    There is no API-key
 *    field in the schema to write to (keys live only in the OS keychain, ADR-0006). And a schema-validation
 *    failure on the write path is reported through the **same value-free formatter** the loader uses
 *    ({@link formatZodError}) — never a raw `ZodError`, whose `.message` embeds the received value for several
 *    codes and could reach stderr — so the secret-free-error property survives future schema changes.
 * 2. **Atomic publication + qualified durability + owner-only.** The `0600` temp file is fsynced before rename;
 *    directory fsync is best effort after publication and its outcome is returned. Crash survival is not guaranteed.
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
  /** The provider serving {@link GlobalPreferenceWrite.defaultModel}, persisted so the next chat skips id inference
   *  (ADR-0059). The picker + wizard always write it TOGETHER with `defaultModel`; on its own it is still a real
   *  partial write (it updates just the provider, leaving the model unchanged), not a no-op. */
  readonly defaultProvider?: LlmProviderId;
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
export interface PreparedConfigWrite {
  /** Whether the target existed when prepared and therefore needs a visible rewrite notice. */
  readonly rewriteNeeded: boolean;
  /** Publish once admitted. The assertion may throw before mutation and immediately before rename. */
  publish(assertAdmitting?: () => void): ConfigWriteResult;
}

export interface ConfigWriteResult {
  readonly durability: 'confirmed' | 'unconfirmed';
}

/** Fixed, path-free refusal for an existing final-component symlink. */
export class ConfigWriteRefusedError extends CliError {
  readonly reason = 'symlink_target';
  constructor() {
    super(
      'config_error',
      'Config is a symbolic link. Edit it manually or replace the link with a regular file.',
    );
    this.name = 'ConfigWriteRefusedError';
  }
}

export function writeGlobalPreferences(
  prefs: GlobalPreferenceWrite,
  home: string = homedir(),
  targetPath?: string,
): ConfigWriteResult {
  return prepareGlobalPreferences(prefs, home, targetPath).publish();
}

export function prepareGlobalPreferences(
  prefs: GlobalPreferenceWrite,
  home: string = homedir(),
  targetPath?: string,
): PreparedConfigWrite {
  // An empty model request performs no I/O; confirmed describes the absence of a pending publication.
  if (
    prefs.defaultModel === undefined &&
    prefs.defaultProvider === undefined &&
    prefs.reasoningEffort === undefined
  ) {
    return {
      rewriteNeeded: false,
      publish: (assertAdmitting) => {
        assertAdmitting?.();
        return { durability: 'confirmed' };
      },
    };
  }
  return prepareWrite(
    (existing) => ({
      ...existing.preferences,
      ...(prefs.defaultModel === undefined ? {} : { default_model: prefs.defaultModel }),
      ...(prefs.defaultProvider === undefined ? {} : { default_provider: prefs.defaultProvider }),
      ...(prefs.reasoningEffort === undefined ? {} : { reasoning_effort: prefs.reasoningEffort }),
    }),
    home,
    targetPath,
  );
}

type StandardConsent = NonNullable<
  NonNullable<GlobalConfig['preferences']>['standard_env_key_consent']
>;
type StandardProvider = keyof StandardConsent;
const STANDARD_NAMES: Required<StandardConsent> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function prepareStandardEnvKeyConsent(
  provider: StandardProvider,
  home: string = homedir(),
  targetPath?: string,
): PreparedConfigWrite {
  return prepareWrite(
    (existing) => ({
      ...existing.preferences,
      standard_env_key_consent: {
        ...existing.preferences?.standard_env_key_consent,
        [provider]: STANDARD_NAMES[provider],
      },
    }),
    home,
    targetPath,
  );
}

export function prepareKeychainUnavailableAcknowledged(
  value: boolean,
  home: string = homedir(),
  targetPath?: string,
): PreparedConfigWrite {
  return prepareWrite(
    (existing) => ({ ...existing.preferences, keychain_unavailable_acknowledged: value }),
    home,
    targetPath,
  );
}

function checkTarget(target: string): boolean {
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new ConfigWriteRefusedError();
    return true;
  } catch (err) {
    if (err instanceof ConfigWriteRefusedError) throw err;
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')
      return false;
    throw new ConfigError(target, 'could not be inspected for writing.', { cause: err });
  }
}

function prepareWrite(
  update: (existing: GlobalConfig) => NonNullable<GlobalConfig['preferences']>,
  home: string,
  targetPath?: string,
): PreparedConfigWrite {
  const target = targetPath ?? globalConfigPath(home);
  const dir = dirname(target);
  // This precedes the loader and any creation or chmod, including for dangling links.
  const rewriteNeeded = checkTarget(target);
  const existing = loadConfigFile<GlobalConfig>(target, GlobalConfigSchema) ?? {};
  const validated = validateForWrite({ ...existing, preferences: update(existing) }, target);
  const text = stringifyToml(validated);
  verifyRoundTrips(text, target);
  let published = false;
  return {
    rewriteNeeded,
    publish(assertAdmitting = () => {}) {
      if (published) throw new Error('Config write was already published.');
      assertAdmitting();
      // If a target appeared after preparing, a rewrite notice was not presented.
      if (checkTarget(target) !== rewriteNeeded) {
        throw new ConfigError(target, 'changed before writing; prepare the write again.');
      }
      if (targetPath === undefined) {
        try {
          ensureGlobalConfigDir(home);
        } catch (err) {
          throw new ConfigError(
            target,
            'could not be written — its directory could not be created.',
            { cause: err },
          );
        }
      }
      const result = writeFileAtomic(dir, target, text, () => {
        assertAdmitting();
        if (checkTarget(target) !== rewriteNeeded) {
          throw new ConfigError(target, 'changed before writing; prepare the write again.');
        }
      });
      published = true;
      return result;
    },
  };
}

/** Set the global `[preferences].default_model` (the common single-key write) — a thin wrapper over
 *  {@link writeGlobalPreferences}. Kept as the named setter the onboarding wizard + the non-effort callers use. */
export function writeGlobalDefaultModel(
  model: string,
  home: string = homedir(),
  targetPath?: string,
): ConfigWriteResult {
  return writeGlobalPreferences({ defaultModel: model }, home, targetPath);
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
 * pre-publication failure the temp is best-effort removed and a typed {@link ConfigError} is thrown; admission
 * and refusal errors retain their identity. Directory-sync failure returns unconfirmed after publication.
 *
 * Exported ONLY as a test seam — for the fault-injection test that drives the catch path with a real failing
 * rename (a `target` that is an existing directory ⇒ `EISDIR`), verifying the temp is cleaned up and the fd is
 * not leaked. It is NOT part of the writer's public contract: it is a generic "replace this path with this text"
 * primitive with no schema, so the secret-incapability guarantee is a property of {@link writeGlobalPreferences}
 * (the typed setter), never of this helper. Do not call it to write arbitrary content.
 */
export function writeFileAtomic(
  dir: string,
  target: string,
  text: string,
  beforeRename?: () => void,
): ConfigWriteResult {
  const tmp = join(dir, `config.toml.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let admissionFailed = false;
  try {
    fd = openSync(tmp, 'wx', 0o600); // `wx`: fail if it exists (the uuid makes a collision impossible); O_EXCL refuses a symlink
    writeFileSync(fd, text, 'utf8');
    fchmodSync(fd, 0o600); // owner-only, independent of umask
    fsyncSync(fd); // the temp is durably on disk before the rename
    closeSync(fd);
    fd = undefined;
    try {
      beforeRename?.();
    } catch (err) {
      admissionFailed = true;
      throw err;
    }
    renameSync(tmp, target); // replaces the directory entry — never writes THROUGH a symlink at `target`
    return { durability: fsyncDir(dir) ? 'confirmed' : 'unconfirmed' };
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
    if (admissionFailed || err instanceof ConfigWriteRefusedError || err instanceof ConfigError)
      throw err;
    throw new ConfigError(target, 'could not be written', { cause: err });
  }
}

/**
 * Best-effort directory fsync, returning false on failure after the rename has published the new file.
 * This must never throw or misreport an already published write as an untouched failure.
 */
function fsyncDir(dir: string): boolean {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, 'r');
    fsyncSync(dfd);
    return true;
  } catch {
    return false;
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
