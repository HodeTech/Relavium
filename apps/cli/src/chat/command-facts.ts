import { resolve } from 'node:path';

import { isProtectedPath } from '../engine/tool-host/fs.js';

/**
 * What the command card says about a command and which answers it offers ([ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md)
 * §1). Pure: the card draws these facts, the hook decides what an answer may do, and neither refuses a command by them. The
 * code-carrier table is a speed bump that makes the common ways of hiding a script in one argument visible on the card, and is
 * NOT a security boundary (the boundary is the full argv on the card, exact-argv matching and `auto`'s hard edge). It is closed,
 * lives in this one place, and is meant to grow.
 */

export type CodeCarrierKind = 'shell' | 'inline-code' | 'wrapper';

const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
]);
const INTERPRETERS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'lua',
  'osascript',
]);
/** The flags that hand an interpreter a program inline. `node build.js` and `python -m pytest` carry none of them. */
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '-e',
  '-E',
  '-p',
  '-r',
  '--eval',
  '--command',
  '--print',
]);
const WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'sudo',
  'doas',
  'xargs',
  'nohup',
  'nice',
  'timeout',
  'time',
  'stdbuf',
  'exec',
  'command',
  'ssh',
  'watch',
]);
/** `find` runs another command with these; the wrapped command is not parsed, `find` itself is flagged. */
const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** The program's base name, compared case-folded and without a trailing `.exe` (`C:\Tools\Python.EXE` is `python`). */
export function programName(program: string): string {
  const base = (program.split(/[\\/]/u).at(-1) ?? '').toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/** Whether the argv is a code carrier (ADR-0118 §1), and which kind; `undefined` for a command that runs only itself. */
export function codeCarrier(argv: readonly string[]): CodeCarrierKind | undefined {
  const program = argv[0];
  if (program === undefined) return undefined;
  const name = programName(program);
  const rest = argv.slice(1);
  if (SHELLS.has(name)) return 'shell';
  if (INTERPRETERS.has(name) && rest.some((argument) => INLINE_CODE_FLAGS.has(argument)))
    return 'inline-code';
  if (WRAPPERS.has(name)) return 'wrapper';
  if (name === 'find' && rest.some((argument) => FIND_EXEC_FLAGS.has(argument))) return 'wrapper';
  return undefined;
}

/**
 * Whether an argument, resolved LEXICALLY against the working directory the command will run in, is a path the file tools
 * would not touch: a credential store the read floor refuses (`.env`, `.ssh`, `.aws`, `.docker/config.json`, …) or a path the
 * write floor protects (`.git`, `.relavium`, startup files). A `--flag=value` is read at its value too. Nothing is resolved on
 * disk and no shell expansion is imagined (the command is spawned without a shell), so the answer is the same for every state of
 * the file system and carries no probe oracle.
 */
export function namesProtectedPath(argv: readonly string[], cwd: string): boolean {
  for (const argument of argv) {
    if (argument === '' || argument.includes('\0')) continue;
    const candidates = argument.includes('=')
      ? [argument, argument.slice(argument.indexOf('=') + 1)]
      : [argument];
    for (const candidate of candidates) {
      if (candidate === '') continue;
      if (isProtectedPath(resolve(cwd, candidate))) return true;
    }
  }
  return false;
}

/** Where a command stands before the person answers. A command approved earlier this session never reaches a card. */
export type CommandStanding = 'allowlisted' | 'remembered' | 'not-pre-approved';

export interface CommandOffers {
  /** `Ctrl+G`, Enter: this exact argv for the rest of this session (in memory). */
  readonly session: boolean;
  /** `Ctrl+O`, Enter: this exact argv for this project, kept in the operator's grants file. */
  readonly remember: boolean;
}

/** Everything a command card needs besides the command itself. */
export interface CommandCardFacts {
  readonly standing: CommandStanding;
  /** The command is a code carrier: its card says it runs code, and Remember is not offered. */
  readonly runsCode: boolean;
  /** An argument names a protected path: its card says so and the only answer that approves is Once. */
  readonly protectedPath: boolean;
  /** The directory the command will run in: the host's, never the model's. */
  readonly cwd: string;
  readonly offers: CommandOffers;
}

export interface CommandFactsInput {
  readonly argv: readonly string[];
  readonly commandAdmitted: boolean;
  readonly remembered: boolean;
  readonly cwd: string;
  /** Whether the host offers a session answer at all (a delivered saved result, a blank preview or the headless path do not). */
  readonly sessionOffered: boolean;
  /** Whether the grants store can write a grant right now (it is usable, has room, and is not a headless surface's). */
  readonly rememberAvailable: boolean;
}

/**
 * The facts and the answers a card offers: Once always; Session unless the command names a protected path (Once only there);
 * Remember only when the store can write, the command is not a code carrier and it names no protected path.
 */
export function commandCardFacts(input: CommandFactsInput): CommandCardFacts {
  const runsCode = codeCarrier(input.argv) !== undefined;
  const protectedPath = namesProtectedPath(input.argv, input.cwd);
  return {
    standing: input.commandAdmitted
      ? 'allowlisted'
      : input.remembered
        ? 'remembered'
        : 'not-pre-approved',
    runsCode,
    protectedPath,
    cwd: input.cwd,
    offers: {
      session: input.sessionOffered && !protectedPath,
      remember: input.rememberAvailable && !runsCode && !protectedPath,
    },
  };
}
