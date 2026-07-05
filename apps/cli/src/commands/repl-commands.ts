/**
 * The **curated in-REPL command registry** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C — see the amendment). The `/` palette + slash commands inside the Home and chat surface only the commands
 * that make sense in a live REPL: lifecycle (`/exit`, `/cancel`, `/export`, `/clear`) and info/discovery (`/help`,
 * `/workflows`, `/cost`, `/doctor`). `/shortcuts` was dropped (S6) — the `/` palette
 * (its own nav hints) + the footer hint-bar handle keymap discoverability in context. The heavy, session-starting
 * **shell** commands (`run`, `chat`, `provider`, …) stay shell-only ([manifest.ts](manifest.ts) /
 * [dispatch.ts](dispatch.ts)) — never run from inside a chat.
 *
 * REPL commands have a different shape than shell commands: their handler runs over a {@link ReplCommandContext}
 * (the live session's lifecycle capabilities), not a `CommandInput` + the durable stores. So this is a separate,
 * purpose-built registry — the single source for the palette, the `/help` list, and the unknown-slash hint, so
 * those three can never disagree. The set is deliberately small and **alias-free**.
 */

import { CHAT_MODES } from '../chat/chat-mode.js';
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
  /** Switch the chat mode (ADR-0057). Receives the raw mode-name token (empty ⇒ show the current mode + options).
   *  The surface parses + applies it (re-applying the turn policy on the same session) and reports the result. */
  readonly setMode: (modeArg: string) => void | Promise<void>;
  /** `/compact` (ADR-0062) — model-summarise the working context into a preamble (an LLM call). Async — the
   *  surface shows a "Summarizing…" notice while awaiting, then reports the token deltas + summary. */
  readonly compactHistory: () => void | Promise<void>;
  /** `/trim [n]` (ADR-0062) — deterministically drop older messages to the last `n` (default `[chat].max_messages`),
   *  no LLM call. Receives the raw `n` token (empty ⇒ use the config default). */
  readonly trimHistory: (nArg: string) => void | Promise<void>;
  /** `/clear` (ADR-0062 §7) — end THIS conversation (persisted + still resumable via `chat-resume`) and start a
   *  FRESH session under a new `sessionId`. A destructive HOST-LEVEL lifecycle swap (no engine primitive), so its
   *  effect on the running REPL differs by surface: a live chat (standalone or in-Home) tears the current session
   *  down and swaps in a fresh one; the BARE Home (no live session) surfaces an inert "nothing to clear" notice.
   *  Interactive-only — a `--json` / plain non-TTY session rejects it (one machine stream is one session lifecycle).
   *  Its notice surfaces the OLD sessionId + `relavium chat-resume <id>` so the prior conversation is discoverable. */
  readonly clearSession: () => void | Promise<void>;
  /** `/models` (2.5.G S7, [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §10) — open the in-tree
   *  model picker over the merged live/static catalog; on selection it writes the NEXT session's default model
   *  ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md)), it does NOT rebind the live session
   *  (that is the Phase-2.6 reseat, ADR-0059). HOME-ONLY (`availableIn: ['home']`): the Home wires the real picker;
   *  the chat surface never reaches this (the slash dispatch rejects a non-`chat` command), so its impl is inert. */
  readonly openModels: () => void | Promise<void>;
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
   *  `write` (creates a file) / `destructive` (irreversibly removes — e.g. `/clear`, which ends the current session). */
  readonly effect: CommandEffect;
  /** The flags this command accepts after its name (omitted ⇒ zero-arg). The dispatch rejects any token not
   *  listed here, so a zero-arg command still rejects `/exit now`. */
  readonly args?: readonly ReplArg[];
  /** An optional single POSITIONAL value the command accepts (e.g. `/mode plan`) — the dispatch accepts a token
   *  in `values` (in addition to any declared flags) and rejects anything else, so an invalid value is caught
   *  before `run`. The palette still submits the BARE `/<name>` (no positional), so `run` handles the empty arg. */
  readonly positional?: { readonly name: string; readonly values: readonly string[] };
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
  {
    name: 'mode',
    label: 'Mode',
    description: 'Switch the chat mode: ask / plan / accept-edits / auto (or Shift+Tab to cycle).',
    effect: 'read',
    // A single positional mode name; the dispatch validates it against these values, so `run` only ever sees a
    // valid mode or an empty arg (the palette's bare `/mode` — which shows the current mode + the options).
    positional: { name: 'mode', values: [...CHAT_MODES] },
    run: (ctx, args) => ctx.setMode(args[0] ?? ''),
    availableIn: ['chat'],
  },
  {
    name: 'compact',
    label: 'Compact',
    description: 'Summarise the conversation so far to reclaim context (spends tokens).',
    effect: 'write',
    run: (ctx) => ctx.compactHistory(),
    availableIn: ['chat'],
  },
  {
    name: 'trim',
    label: 'Trim',
    description:
      'Deterministically drop older messages (no LLM call); /trim [n], default [chat].max_messages.',
    effect: 'read',
    // An optional numeric bound; a FREE positional (empty `values`) accepts any single token — `run` validates it.
    positional: { name: 'n', values: [] },
    run: (ctx, args) => ctx.trimHistory(args[0] ?? ''),
    availableIn: ['chat'],
  },
  {
    name: 'clear',
    label: 'Clear',
    description: 'End this conversation (saved + resumable) and start a fresh session.',
    // `destructive` in the forward taxonomy (ADR-0062 §7): it ends the current session — still persisted +
    // resumable via `chat-resume` — and swaps in a fresh one under a new sessionId. Offered in BOTH surfaces'
    // palettes (['home','chat']): a live chat (standalone OR in-Home) performs the swap, while the BARE Home has
    // no session and surfaces an inert "nothing to clear" notice (see homeReplCtx). Zero-arg (`/clear x` rejects).
    effect: 'destructive',
    run: (ctx) => ctx.clearSession(),
    availableIn: ['home', 'chat'],
  },
  {
    name: 'models',
    label: 'Models',
    description: 'Pick your default model (opens the catalog picker).',
    // `read` in the forward taxonomy: opening the picker changes nothing; the config write happens only on an
    // explicit selection (ADR-0063), and even then it sets the NEXT session's default, never the running one.
    effect: 'read',
    // HOME-ONLY (ADR-0064 §10): a next-session CONFIG action, deliberately distinct from the Phase-2.6 mid-chat
    // `/models` live reseat (ADR-0059). Inside a live chat the slash dispatch rejects it with a pointer to the Home.
    run: (ctx) => ctx.openModels(),
    availableIn: ['home'],
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
  if (command.positional !== undefined) {
    Object.freeze(command.positional.values);
    Object.freeze(command.positional);
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
