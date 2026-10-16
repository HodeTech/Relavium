import { isAbsolute } from 'node:path';

import { CliError } from './cli-error.js';
import { FS_ROOT_LIMITS } from '@relavium/shared/fs-root-limits';
import { resolveDiagnosticPolicy, type Verbosity } from './diagnostic-policy.js';
export type { Verbosity } from './diagnostic-policy.js';
import { globalOptionForSpelling, type GlobalOptionDescriptor } from '../commands/descriptors.js';
import type { InvocationFsGrants } from '../engine/tool-host/fs-policy.js';

/**
 * Resolved, normalized global options every command inherits. The global flags are
 * **position-independent** (`relavium run wf --json` and `relavium --json run wf` are
 * equivalent), so they are owned here — extracted from argv before `commander` parses the
 * rest — rather than declared as `commander` options (which bind to the command they follow).
 */

export interface GlobalOptions {
  readonly json: boolean;
  readonly color: boolean;
  readonly cwd: string;
  readonly configPath: string | undefined;
  readonly verbosity: Verbosity;
  /** `true` when `--no-alt-screen` was passed — a per-invocation opt-out of the full-screen alt-screen renderer
   *  (2.6.F, ADR-0068 §e). Overrides `[preferences].alt_screen`; the effective mode is resolved by
   *  `resolveRenderMode` (render-mode.ts), which also gates on TTY + machine output. OPTIONAL (unlike the other
   *  resolved fields) so the many test fixtures that predate it need no churn — `resolveGlobalOptions` always
   *  populates it in production, and an absent value reads as `false` (alt-screen not force-disabled). */
  readonly noAltScreen?: boolean;
  /** `true` when `--no-mouse` was passed — a per-invocation opt-out of terminal mouse reporting in the full-screen
   *  renderer (2.6.F, ADR-0068 §e). Overrides `[preferences].mouse`; the effective decision is resolved by
   *  `resolveMouseMode` (render-mode.ts), which also gates on the alt screen being active at all. OPTIONAL for the
   *  same reason as {@link noAltScreen} — an absent value reads as `false` (mouse not force-disabled). */
  readonly noMouse?: boolean;
  /** Operator-authored flags only. Never persisted or populated from config/environment. */
  readonly allowFsRoots?: readonly string[];
  /** Host-owned invocation authority captured before dispatcher composition. */
  readonly fsGrants?: InvocationFsGrants;
}

/** The raw global-flag values harvested from argv (before normalization). */
export interface RawGlobalOptions {
  json?: boolean;
  /** `true` for `--color`, `false` for `--no-color`; absent ⇒ resolved from `NO_COLOR`/`FORCE_COLOR`/default. */
  color?: boolean;
  cwd?: string;
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  /** `true` for `--no-alt-screen` (the only alt-screen flag — the DISABLE opt-out; enabling is via
   *  `[preferences].alt_screen`, ADR-0068 §e). Absent ⇒ fall to the config key / phase default. */
  noAltScreen?: boolean;
  /** `true` for `--no-mouse` (the DISABLE opt-out; enabling is via `[preferences].mouse`, ADR-0068 §e).
   *  Absent ⇒ fall to the config key / phase default. */
  noMouse?: boolean;
  allowFsRoots?: string[];
}

export interface ExtractedArgv {
  readonly raw: RawGlobalOptions;
  /** argv with the global flags removed — `[node, script, ...command tokens]`. */
  readonly rest: string[];
  /**
   * A malformed-global-flag error (e.g. `--cwd` with no value). **Returned, not thrown**, so the
   * caller can render it honoring any `--json`/`--verbose` already parsed into `raw` before it.
   */
  readonly error?: CliError;
}

/** Descriptor bindings are a closed internal grammar; no prototype lookup consumes unknown argv. */
function applyBoolean(raw: RawGlobalOptions, option: GlobalOptionDescriptor): void {
  switch (option.binding) {
    case 'json':
      raw.json = true;
      break;
    case 'color':
      raw.color = !option.negated;
      break;
    case 'verbose':
      raw.verbose = true;
      break;
    case 'quiet':
      raw.quiet = true;
      break;
    case 'noAltScreen':
      raw.noAltScreen = true;
      break;
    case 'noMouse':
      raw.noMouse = true;
      break;
    default:
      throw new CliError('cli_internal', '');
  }
}

type ValueFlagResult =
  | { readonly kind: 'consumed'; readonly advance: number }
  | { readonly kind: 'error'; readonly error: CliError }
  | { readonly kind: 'skip' };

/**
 * Pull the position-independent global flags out of argv so they may appear anywhere on the
 * command line. `commander` then parses only the remaining commands and their own options
 * (which is why the globals are documented via `addHelpText`, not `.option`, on the program).
 * `--help` / `--version` are deliberately left for `commander`. A POSIX `--` terminator stops
 * extraction: `--` and everything after are passed to `commander` verbatim, so a literal
 * `--json` can be a command argument.
 */
export function extractGlobalOptions(argv: readonly string[]): ExtractedArgv {
  const prefix = argv.slice(0, 2);
  const tokens = argv.slice(2);
  const rest: string[] = [];
  const raw: RawGlobalOptions = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    if (token === '--') {
      // End-of-options: keep `--` and everything after as command tokens, verbatim.
      rest.push(...tokens.slice(i));
      break;
    }
    const option = globalOptionForSpelling(token);
    if (option?.owner === 'extractor' && option.arity === 'none') {
      applyBoolean(raw, option);
      continue;
    }
    const valued = takeValueFlag(raw, token, tokens[i + 1]);
    if (valued.kind === 'error') {
      return { raw, rest: [...prefix, ...rest], error: valued.error };
    }
    if (valued.kind === 'consumed') {
      i += valued.advance;
      continue;
    }
    rest.push(token);
  }

  return { raw, rest: [...prefix, ...rest] };
}

/** Recognize value arity from the same descriptor authority used by help/discovery. */
function takeValueFlag(
  raw: RawGlobalOptions,
  token: string,
  next: string | undefined,
): ValueFlagResult {
  const eq = token.indexOf('=');
  const spelling = eq < 0 ? token : token.slice(0, eq);
  const option = globalOptionForSpelling(spelling);
  if (option?.owner !== 'extractor' || option.arity === 'none') return { kind: 'skip' };
  const value = eq < 0 ? next : token.slice(eq + 1);
  if (value === undefined || value.trim() === '' || (eq < 0 && value.startsWith('-'))) {
    return { kind: 'error', error: requiresArgument(spelling) };
  }
  const error = assignValueFlag(raw, option, value);
  if (error !== undefined) return { kind: 'error', error };
  return { kind: 'consumed', advance: eq < 0 ? 1 : 0 };
}

function assignValueFlag(
  raw: RawGlobalOptions,
  option: GlobalOptionDescriptor,
  value: string,
): CliError | undefined {
  switch (option.binding) {
    case 'allowFsRoots':
      if (
        value.length > FS_ROOT_LIMITS.characters ||
        (raw.allowFsRoots?.length ?? 0) >= FS_ROOT_LIMITS.count
      ) {
        return new CliError(
          'invalid_invocation',
          'Filesystem root grants exceed the supported bounds.',
        );
      }
      if (!isAbsolute(value))
        return new CliError(
          'invalid_invocation',
          'Filesystem root grants must use absolute paths.',
        );
      (raw.allowFsRoots ??= []).push(value);
      return undefined;
    case 'cwd':
      raw.cwd = value;
      return undefined;
    case 'config':
      raw.config = value;
      return undefined;
    default:
      throw new CliError('cli_internal', '');
  }
}

function requiresArgument(flag: string): CliError {
  return new CliError('invalid_invocation', `\`${flag}\` requires a non-empty argument.`);
}

/** Preserve the existing conflict API through the single diagnostic policy. */
export function assertNoGlobalOptionConflicts(raw: RawGlobalOptions): void {
  resolveDiagnosticPolicy(raw, {});
}

/**
 * Resolve the effective color setting — ANSI STYLING only, orthogonal to the `--json`/CI/non-TTY output MODE
 * (which suppresses ANSI separately in `detectOutputMode`, output-mode.ts). Precedence (2.5.J; the flag pair
 * is [ADR-0047](../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md)'s global-flag set):
 *   1. an explicit `--color` / `--no-color` flag (a per-invocation override);
 *   2. `NO_COLOR` — ANY non-empty value ⇒ OFF (the no-color.org accessibility contract);
 *   3. `FORCE_COLOR` — `0`/`false` ⇒ OFF (the `supports-color` convention; the value is checked, unlike NO_COLOR);
 *   4. default ON.
 * Both env vars are opt-OUT signals here: a truthy `FORCE_COLOR` has NO independent effect (color already
 * defaults on, and is consulted only on a TTY where it is on), so there is no `NO_COLOR`-vs-`FORCE_COLOR`
 * conflict to resolve — the flag overrides both, and either env opt-out disables.
 */
function resolveColor(
  raw: RawGlobalOptions,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (raw.color !== undefined) return raw.color; // 1. the explicit flag wins
  if ((env['NO_COLOR'] ?? '') !== '') return false; // 2. NO_COLOR opts out (any non-empty; accessibility floor)
  const force = env['FORCE_COLOR']; // 3. FORCE_COLOR=0/false opts out (supports-color convention)
  if (force === '0' || force === 'false') return false;
  return true; // 4. default on (incl. a truthy FORCE_COLOR)
}

export function resolveGlobalOptions(
  raw: RawGlobalOptions,
  defaultCwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
): GlobalOptions {
  const policy = resolveDiagnosticPolicy(raw, env);
  return {
    json: policy.json,
    color: resolveColor(raw, env),
    cwd: raw.cwd ?? defaultCwd,
    configPath: raw.config,
    verbosity: policy.verbosity,
    noAltScreen: raw.noAltScreen === true,
    noMouse: raw.noMouse === true,
    ...(raw.allowFsRoots === undefined
      ? {}
      : { allowFsRoots: Object.freeze([...raw.allowFsRoots]) }),
  };
}
