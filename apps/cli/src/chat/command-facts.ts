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
  'nodejs',
  'pypy',
  'py',
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
  'busybox',
  'toybox',
  'wsl',
]);
/** The option-like arguments before the first operand: where an interpreter's own flags live (`python -Bc 'code'`, `node -pe …`). */
function leadingOptions(rest: readonly string[]): readonly string[] {
  const end = rest.findIndex((argument) => !argument.startsWith('-') || argument === '-');
  return end < 0 ? rest : rest.slice(0, end);
}

/** Whether an interpreter is handed a program inline: an exact flag anywhere, or (among its own options) `--eval=…` or a short cluster holding one. */
function givesInlineCode(rest: readonly string[]): boolean {
  if (rest.some((argument) => INLINE_CODE_FLAGS.has(argument))) return true;
  return leadingOptions(rest).some(
    (argument) =>
      /^--(?:eval|command|print)=/u.test(argument) ||
      (/^-[A-Za-z]{2,}$/u.test(argument) && /[cEepr]/u.test(argument)),
  );
}

/** `find` runs another command with these; the wrapped command is not parsed, `find` itself is flagged. */
const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** The program's base name, compared case-folded and without a trailing `.exe` (`C:\Tools\Python.EXE` is `python`). */
export function programName(program: string): string {
  // Windows ignores a trailing dot or space and an alternate data stream suffix (`cmd.exe.`, `cmd.exe `, `cmd.exe::$DATA`), so a
  // name written that way must not hide a shell from the table. A drive designator with no separator (`C:cmd.exe`, the drive's
  // current directory) is dropped first, or the stream rule would eat the program name itself.
  const base = (program.split(/[\\/]/u).at(-1) ?? '')
    .toLowerCase()
    .replace(/^[a-z]:/u, '')
    .replace(/:.*$/u, '')
    .replace(/[. ]+$/u, '');
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/** Whether the argv is a code carrier (ADR-0118 §1), and which kind; `undefined` for a command that runs only itself. */
export function codeCarrier(argv: readonly string[]): CodeCarrierKind | undefined {
  const program = argv[0];
  if (program === undefined) return undefined;
  const name = programName(program);
  const rest = argv.slice(1);
  if (SHELLS.has(name)) return 'shell';
  // `python3.12`, `node22`, `perl5.36`: the version is not part of the family.
  const family = name.replace(/[0-9.]+$/u, '');
  if (name === 'deno' && rest[0] === 'eval') return 'inline-code';
  if ((INTERPRETERS.has(name) || INTERPRETERS.has(family)) && givesInlineCode(rest))
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
  for (const [index, argument] of argv.entries()) {
    if (argument === '' || argument.includes('\0')) continue;
    for (const candidate of pathCandidates(argument)) {
      if (candidate === '') continue;
      // The program's own name and a flag are not paths: in a working directory that is itself protected they would resolve to
      // one and put the warning on every command, which teaches people to ignore it. What follows a flag's `=` still counts.
      if (
        candidate === argument &&
        ((index === 0 && !/[\\/]/u.test(argument)) || argument.startsWith('-'))
      )
        continue;
      if (isProtectedPath(resolve(cwd, candidate))) return true;
    }
  }
  return false;
}

/**
 * Where a path-shaped value can hide inside one argument: the argument itself, the text after the first `=` (`--flag=value`,
 * `KEY=value`) or `:` (`git show HEAD:.env`, `scp host:.ssh/id_rsa`), after a leading `@` (`curl -d @.env`), and after an attached
 * one-letter option (`-d@.env`, `-o.env`), each once on top of another. Every candidate is only another thing to warn about.
 */
function pathCandidates(argument: string): readonly string[] {
  const found = new Set<string>([argument]);
  const peel = (text: string): string[] => {
    const out: string[] = [];
    for (const mark of ['=', ':']) {
      const at = text.indexOf(mark);
      if (at >= 0) out.push(text.slice(at + 1));
    }
    if (text.startsWith('@')) out.push(text.slice(1));
    if (/^-[A-Za-z][^A-Za-z-]/u.test(text)) out.push(text.slice(2));
    return out;
  };
  for (const first of peel(argument)) {
    found.add(first);
    for (const second of peel(first)) found.add(second);
  }
  return [...found];
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
  /**
   * The command is remembered but asks anyway in `auto`, because this session has approved a file write since (ADR-0118 §2): the
   * write may have changed what it does. Only the card's standing row says so.
   */
  readonly filesChanged?: boolean | undefined;
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
  /** `auto` asks about a remembered command because this session has approved a file write. */
  readonly filesChanged?: boolean;
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
    filesChanged: input.filesChanged === true && input.remembered && !input.commandAdmitted,
    runsCode,
    protectedPath,
    cwd: input.cwd,
    offers: {
      session: input.sessionOffered && !protectedPath,
      // Nothing to remember for a command already pre-approved (on the allowlist or remembered): `auto` runs it as it is.
      remember:
        input.rememberAvailable &&
        !runsCode &&
        !protectedPath &&
        !input.commandAdmitted &&
        !input.remembered,
    },
  };
}
