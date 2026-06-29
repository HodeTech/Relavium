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

/** The lifecycle capabilities a {@link ReplCommand} can invoke — supplied by the surface (the chat REPL / the Home). */
export interface ReplCommandContext {
  /** End the chat session cleanly (the REPL stops; exit code 4 in a standalone chat). */
  readonly exit: () => void;
  /** Cancel the in-flight turn and end the (persisted, resumable) session. */
  readonly cancel: () => void;
  /** Scaffold the session so far to a `.relavium.yaml` (ADR-0026), between turns. */
  readonly exportSession: () => void;
  /** Surface the command list — a text list today; the interactive `/` palette once it lands (2.5.C S3b). */
  readonly help: () => void;
}

/** One curated in-REPL command. `run` wires the slash name to a {@link ReplCommandContext} capability. */
export interface ReplCommand {
  /** The slash name without the leading `/` (`exit`, `help`) — also the palette/help label key. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** `read` = no data change (lifecycle/info); `write` = creates a file. (Forward annotation, like the manifest.) */
  readonly effect: 'read' | 'write';
  readonly run: (ctx: ReplCommandContext) => void;
}

/** The curated REPL command set — the single source for the palette, `/help`, and the unknown-slash hint. */
export const REPL_COMMANDS: readonly ReplCommand[] = [
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
