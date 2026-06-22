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
}

/** The raw global-flag values harvested from argv (before normalization). */
export interface RawGlobalOptions {
  json?: boolean;
  /** `false` for `--no-color`; otherwise absent (color on). */
  color?: boolean;
  cwd?: string;
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
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

export function resolveGlobalOptions(raw: RawGlobalOptions, defaultCwd: string): GlobalOptions {
  assertNoGlobalOptionConflicts(raw);
  return {
    json: raw.json === true,
    color: raw.color !== false,
    cwd: raw.cwd ?? defaultCwd,
    configPath: raw.config,
    verbosity: resolveVerbosity(raw),
  };
}
