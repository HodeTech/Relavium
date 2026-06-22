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
    if (token === '--json') {
      raw.json = true;
    } else if (token === '--no-color') {
      raw.color = false;
    } else if (token === '--verbose' || token === '-v') {
      raw.verbose = true;
    } else if (token === '--quiet' || token === '-q') {
      raw.quiet = true;
    } else if (token === '--cwd' || token === '--config') {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { raw, rest: [...prefix, ...rest], error: requiresArgument(token) };
      }
      assignValueFlag(raw, token, value);
      i += 1;
    } else if (token.startsWith('--cwd=') || token.startsWith('--config=')) {
      const eq = token.indexOf('=');
      const flag = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (value === '') {
        return { raw, rest: [...prefix, ...rest], error: requiresArgument(flag) };
      }
      assignValueFlag(raw, flag, value);
    } else {
      rest.push(token);
    }
  }

  return { raw, rest: [...prefix, ...rest] };
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

export function resolveGlobalOptions(raw: RawGlobalOptions, defaultCwd: string): GlobalOptions {
  assertNoGlobalOptionConflicts(raw);
  const verbosity: Verbosity =
    raw.quiet === true ? 'quiet' : raw.verbose === true ? 'verbose' : 'normal';
  return {
    json: raw.json === true,
    color: raw.color !== false,
    cwd: raw.cwd ?? defaultCwd,
    configPath: raw.config,
    verbosity,
  };
}
