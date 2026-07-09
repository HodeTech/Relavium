import { CliError } from './errors.js';

/**
 * Resolved, normalized global options every command inherits. The global flags are
 * **position-independent** (`relavium run wf --json` and `relavium --json run wf` are
 * equivalent), so they are owned here — extracted from argv before `commander` parses the
 * rest — rather than declared as `commander` options (which bind to the command they follow).
 */
export type Verbosity = 'quiet' | 'normal' | 'verbose';

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

/** Boolean global flags (no value) → the mutation each applies to the raw options. */
const BOOLEAN_FLAGS: Readonly<Record<string, (raw: RawGlobalOptions) => void>> = {
  '--json': (raw) => {
    raw.json = true;
  },
  '--no-color': (raw) => {
    raw.color = false;
  },
  '--color': (raw) => {
    raw.color = true;
  },
  '--verbose': (raw) => {
    raw.verbose = true;
  },
  '-v': (raw) => {
    raw.verbose = true;
  },
  '--quiet': (raw) => {
    raw.quiet = true;
  },
  '-q': (raw) => {
    raw.quiet = true;
  },
  '--no-alt-screen': (raw) => {
    raw.noAltScreen = true;
  },
};

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
    const applyBoolean = BOOLEAN_FLAGS[token];
    if (applyBoolean !== undefined) {
      applyBoolean(raw);
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

/** Handle the value-bearing flags (`--cwd` / `--config`), spaced or `=`-form. */
function takeValueFlag(
  raw: RawGlobalOptions,
  token: string,
  next: string | undefined,
): ValueFlagResult {
  if (token.startsWith('--cwd=') || token.startsWith('--config=')) {
    const eq = token.indexOf('=');
    const flag = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (value.trim() === '') {
      return { kind: 'error', error: requiresArgument(flag) };
    }
    assignValueFlag(raw, flag, value);
    return { kind: 'consumed', advance: 0 };
  }
  if (token === '--cwd' || token === '--config') {
    if (next === undefined || next.startsWith('-') || next.trim() === '') {
      return { kind: 'error', error: requiresArgument(token) };
    }
    assignValueFlag(raw, token, next);
    return { kind: 'consumed', advance: 1 };
  }
  return { kind: 'skip' };
}

function assignValueFlag(raw: RawGlobalOptions, flag: string, value: string): void {
  if (flag === '--cwd') {
    raw.cwd = value;
  } else {
    raw.config = value;
  }
}

function requiresArgument(flag: string): CliError {
  return new CliError('invalid_invocation', `\`${flag}\` requires a non-empty argument.`);
}

/** The one cross-flag rule: `--verbose` and `--quiet` are mutually exclusive. */
export function assertNoGlobalOptionConflicts(raw: RawGlobalOptions): void {
  if (raw.verbose === true && raw.quiet === true) {
    throw new CliError('invalid_invocation', '`--verbose` and `--quiet` cannot be combined.');
  }
}

function resolveVerbosity(raw: RawGlobalOptions): Verbosity {
  if (raw.quiet === true) {
    return 'quiet';
  }
  if (raw.verbose === true) {
    return 'verbose';
  }
  return 'normal';
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
  assertNoGlobalOptionConflicts(raw);
  return {
    json: raw.json === true,
    color: resolveColor(raw, env),
    cwd: raw.cwd ?? defaultCwd,
    configPath: raw.config,
    verbosity: resolveVerbosity(raw),
    noAltScreen: raw.noAltScreen === true,
  };
}
