/**
 * The **curated in-REPL command registry** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C — see the amendment). The `/` palette + slash commands inside the Home and chat surface only the commands
 * that make sense in a live REPL: lifecycle (`/exit`, `/cancel`, `/export`) and info/discovery (`/help`,
 * `/workflows`, `/cost`, `/doctor`; `/clear` is a future addition). `/shortcuts` was dropped (S6) — the `/` palette
 * (its own nav hints) + the footer hint-bar handle keymap discoverability in context. The heavy, session-starting
 * **shell** commands (`run`, `chat`, `provider`, …) stay shell-only ([manifest.ts](manifest.ts) /
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
  /** List the project's discovered workflows + agents (the disk catalog) as a notice (2.5.C S4). */
  readonly showWorkflows: () => void | Promise<void>;
  /** Show the session's cumulative cost as a notice (2.5.C S4; the per-model breakdown is 2.6.C). */
  readonly showCost: () => void | Promise<void>;
  /** Run the `/doctor` health check (2.5.C S5); `deep` adds the network/process tier (key + MCP validation). */
  readonly runDoctor: (deep: boolean) => void | Promise<void>;
}

/** A flag a {@link ReplCommand} accepts after its name (e.g. `/doctor --deep`). Flags only — the curated set has
 *  no positionals; a future positional command would extend this, not work around it. */
export interface ReplArg {
  readonly flag: string;
  readonly description: string;
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
  /** The flags this command accepts after its name (omitted ⇒ zero-arg). The dispatch rejects any token not
   *  listed here, so a zero-arg command still rejects `/exit now`. */
  readonly args?: readonly ReplArg[];
  /** Run the command; receives the validated post-name arg tokens (empty for a zero-arg command). May be async
   *  (an awaited `Promise<void>`), so `/cost` / `/doctor` are safe. */
  readonly run: (ctx: ReplCommandContext, args: readonly string[]) => void | Promise<void>;
  /** The surfaces the command applies to — `chat` (a live session) and/or `home` (the bare management strip).
   *  A lifecycle command like `/cancel` is `chat`-only (no turn to cancel in the Home); `/exit` is both. The
   *  palette of each surface shows only its applicable commands (2.5.C S3c). */
  readonly availableIn: readonly ('home' | 'chat')[];
}

/**
 * **Args (the prior S4 obligation, discharged in S5).** A command MAY declare {@link ReplCommand.args} — the
 * flags it accepts after its name (`/doctor --deep`). The in-REPL dispatch (createChatLineHandler) splits the
 * slash line into `name + tokens`, REJECTS a token not in the command's declared flags (so a zero-arg command
 * still rejects `/exit now`), and passes the validated tokens to `run(ctx, args)`. The `/` palette captures NO
 * args: selecting a command submits the BARE `/<name>` (its default / fast behavior) — a flag like `--deep` is
 * opt-in by TYPING it. The set stays flags-only (no positionals).
 */

/** The curated REPL command set — the single source for the palette, `/help`, and the unknown-slash hint. */
const RAW_REPL_COMMANDS: readonly ReplCommand[] = [
  {
    name: 'help',
    label: 'Help',
    description: 'List the available slash commands.',
    // `/help` (the text list) is reachable only by being TYPED in a chat REPL — it is excluded from the `/`
    // palette (the palette IS the interactive help) and the Home has no typed-slash dispatch, so it never runs
    // as a command in the Home. Hence `chat` only; the palette-key discovery still opens in both surfaces.
    effect: 'read',
    run: (ctx) => ctx.help(),
    availableIn: ['chat'],
  },
  {
    name: 'exit',
    label: 'Exit',
    description: 'End the chat session.',
    effect: 'read',
    run: (ctx) => ctx.exit(),
    availableIn: ['home', 'chat'],
  },
  {
    name: 'cancel',
    label: 'Cancel',
    description: 'Cancel the current turn and end the (resumable) session.',
    effect: 'read',
    run: (ctx) => ctx.cancel(),
    availableIn: ['chat'],
  },
  {
    name: 'export',
    label: 'Export session',
    description: 'Scaffold the session so far to a .relavium.yaml.',
    effect: 'write',
    run: (ctx) => ctx.exportSession(),
    availableIn: ['chat'],
  },
  {
    name: 'workflows',
    label: 'Workflows',
    description: 'List the workflows and agents discovered in this project.',
    effect: 'read',
    run: (ctx) => ctx.showWorkflows(),
    availableIn: ['chat'],
  },
  {
    name: 'cost',
    label: 'Cost',
    description: "Show this session's cumulative cost.",
    effect: 'read',
    run: (ctx) => ctx.showCost(),
    availableIn: ['chat'],
  },
  {
    name: 'doctor',
    label: 'Doctor',
    description: 'Check your setup; --deep also validates keys + MCP.',
    effect: 'read',
    args: [
      {
        flag: '--deep',
        description: 'Also validate provider keys and MCP connectivity (network).',
      },
    ],
    // The palette runs the fast tier (`deep: false`); `--deep` is opt-in by typing it. `/doctor` is a REAL Home
    // capability (pre-chat diagnostics), so it is `availableIn` both surfaces (homeReplCtx wires a live impl).
    run: (ctx, args) => ctx.runDoctor(args.includes('--deep')),
    availableIn: ['home', 'chat'],
  },
];

/** DEEP-freeze a curated command — the entry, its `args` array + each flag, and its `availableIn` array — so no
 *  downstream code can mutate the registry (or its nested `args`/`availableIn`) at runtime. Parity with
 *  `COMMAND_MANIFEST`'s `freezeEntry`. */
function freezeReplCommand(command: ReplCommand): ReplCommand {
  if (command.args !== undefined) {
    command.args.forEach((arg) => Object.freeze(arg));
    Object.freeze(command.args);
  }
  Object.freeze(command.availableIn);
  return Object.freeze(command);
}

/** The deep-frozen curated command set (each entry + its nested arrays immutable at runtime). */
export const REPL_COMMANDS: readonly ReplCommand[] = Object.freeze(
  RAW_REPL_COMMANDS.map(freezeReplCommand),
);

/** O(1) lookup of a REPL command by its slash name (no leading `/`). The `ReadonlyMap` type is the mutation guard
 *  (a `Map`'s internal data can't be `Object.freeze`d); every command it holds is deep-frozen above. */
export const REPL_COMMANDS_BY_NAME: ReadonlyMap<string, ReplCommand> = new Map(
  REPL_COMMANDS.map((command) => [command.name, command]),
);

/**
 * The commands the interactive `/` palette offers — every curated command EXCEPT `/help`: the palette IS the
 * interactive help, so listing `/help` would be circular (and selecting it would print the text list to stderr
 * behind the live ink view). `/help` stays a typed / non-TTY text-list affordance (the unknown-slash fallback).
 */
export const PALETTE_COMMANDS: readonly ReplCommand[] = Object.freeze(
  REPL_COMMANDS.filter((command) => command.name !== 'help'),
);

/** The palette commands available in a live chat (S3b) — every palette command whose `availableIn` includes `chat`. */
export const CHAT_PALETTE_COMMANDS: readonly ReplCommand[] = Object.freeze(
  PALETTE_COMMANDS.filter((command) => command.availableIn.includes('chat')),
);

/** The palette commands available in the bare Home (S3c) — `availableIn` includes `home`: `/exit` plus `/doctor`
 *  (S5, pre-chat diagnostics). The chat-only info commands (`/workflows` / `/cost`) stay out of the Home set. */
export const HOME_PALETTE_COMMANDS: readonly ReplCommand[] = Object.freeze(
  PALETTE_COMMANDS.filter((command) => command.availableIn.includes('home')),
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
