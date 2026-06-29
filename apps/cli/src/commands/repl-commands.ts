/**
 * The **curated in-REPL command registry** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C — see the amendment). The `/` palette + slash commands inside the Home and chat surface only the commands
 * that make sense in a live REPL: lifecycle (`/exit`, `/cancel`, `/export`) and info/discovery (`/help`, and —
 * landing in later 2.5.C steps — `/shortcuts`, `/cost`, `/workflows`, `/doctor`, `/clear`). The heavy,
 * session-starting **shell** commands (`run`, `chat`, `provider`, …) stay shell-only ([manifest.ts](manifest.ts) /
 * [dispatch.ts](dispatch.ts)) — never run from inside a chat.
 *
 * REPL commands have a different shape than shell commands: their handler runs over a {@link ReplCommandContext}
 * (the live session's lifecycle capabilities), not a `CommandInput` + the durable stores. So this is a separate,
 * purpose-built registry — the single source for the palette, the `/help` list, and the unknown-slash hint, so
 * those three can never disagree. The set is deliberately small and **alias-free**.
 */

import type { CommandEffect } from './manifest.js';

/**
 * The lifecycle capabilities a {@link ReplCommand} can invoke — supplied by the surface (the chat REPL / the
 * Home). Each may be sync or async (`void | Promise<void>`): `help` opens the interactive `/` palette in 2.5.C
 * S3b, and later info commands (`/cost`, `/doctor`) read/probe asynchronously — so a capability's promise is
 * always awaited (see {@link ReplCommand.run}), never silently fire-and-forget.
 */
export interface ReplCommandContext {
  /** End the chat session cleanly (the REPL stops; exit code 4 in a standalone chat). */
  readonly exit: () => void | Promise<void>;
  /** Cancel the in-flight turn and end the (persisted, resumable) session. */
  readonly cancel: () => void | Promise<void>;
  /** Scaffold the session so far to a `.relavium.yaml` (ADR-0026), between turns. */
  readonly exportSession: () => void | Promise<void>;
  /** Surface the command list — a text list today; the interactive `/` palette once it lands (2.5.C S3b). */
  readonly help: () => void | Promise<void>;
}

/** One curated in-REPL command. `run` wires the slash name to a {@link ReplCommandContext} capability. */
export interface ReplCommand {
  /** The slash name without the leading `/` (`exit`, `help`) — also the palette/help label key. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** A forward annotation, shared with the shell manifest ({@link CommandEffect}): `read` (no data change) /
   *  `write` (creates a file) / `destructive` (irreversibly removes — e.g. a future `/clear`). */
  readonly effect: CommandEffect;
  /** Run the command; may be async (an awaited `Promise<void>`), so a future `/cost` / `/doctor` is safe. */
  readonly run: (ctx: ReplCommandContext) => void | Promise<void>;
}

/**
 * **Args are NOT modelled here yet (an S4 obligation).** A 2.5.C palette selection submits the bare `/<name>`
 * line, and the in-REPL dispatch (createChatLineHandler) **exact-matches** the whole post-slash string — so every
 * curated command must be runnable with no args (today's set is). When an arg-taking command lands (e.g.
 * `/doctor --deep`, `/trim <n>`), S4 must BOTH (a) add an `args` shape here + an arg-entry/parse path so a typed
 * `/<name> <args>` dispatches (the exact-match must become a name+args parse), and (b) decide how the palette
 * captures args on select (prompt after, or insert `/<name> ` into the buffer). Do not discover this mid-S4.
 */

/** The curated REPL command set — the single source for the palette, `/help`, and the unknown-slash hint. */
const RAW_REPL_COMMANDS: readonly ReplCommand[] = [
  {
    name: 'help',
    label: 'Help',
    description: 'List the available slash commands.',
    effect: 'read',
    run: (ctx) => ctx.help(),
  },
  {
    name: 'exit',
    label: 'Exit',
    description: 'End the chat session.',
    effect: 'read',
    run: (ctx) => ctx.exit(),
  },
  {
    name: 'cancel',
    label: 'Cancel',
    description: 'Cancel the current turn and end the (resumable) session.',
    effect: 'read',
    run: (ctx) => ctx.cancel(),
  },
  {
    name: 'export',
    label: 'Export session',
    description: 'Scaffold the session so far to a .relavium.yaml.',
    effect: 'write',
    run: (ctx) => ctx.exportSession(),
  },
];

/** The frozen curated command set (each entry + the array immutable at runtime, parity with `COMMAND_MANIFEST`). */
export const REPL_COMMANDS: readonly ReplCommand[] = Object.freeze(
  RAW_REPL_COMMANDS.map((command) => Object.freeze(command)),
);

/** O(1) lookup of a REPL command by its slash name (no leading `/`). */
export const REPL_COMMANDS_BY_NAME: ReadonlyMap<string, ReplCommand> = new Map(
  REPL_COMMANDS.map((command) => [command.name, command]),
);

/** The comma-separated slash list for the unknown-slash hint — `/help, /exit, /cancel, /export`. */
export function replCommandList(): string {
  return REPL_COMMANDS.map((command) => `/${command.name}`).join(', ');
}

/** The multi-line `/help` body — one line per command (`/name  description`). */
export function formatReplHelp(): string {
  const rows = REPL_COMMANDS.map((command) => `  /${command.name}  ${command.description}`);
  return `Commands:\n${rows.join('\n')}\n`;
}
