/**
 * The **curated in-REPL command registry** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C — see the amendment). The `/` palette + slash commands inside the Home and chat surface only the commands
 * that make sense in a live REPL: lifecycle (`/exit`, `/cancel`, `/export`, `/clear`) and info/discovery (`/help`,
 * `/workflows`, `/cost`, `/doctor`). `/shortcuts` was dropped (S6) — the `/` palette
 * (its own nav hints) + the footer hint-bar handle keymap discoverability in context. A slash command never spawns
 * a **shell** command ([manifest.ts](manifest.ts) / [dispatch.ts](dispatch.ts)); under
 * [ADR-0122](../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) a routine task gets an in-TUI
 * form here that re-hosts the same core as its shell command.
 *
 * REPL commands have a different shape than shell commands: their handler runs over a {@link ReplCommandContext}
 * (the live session's lifecycle capabilities), not a `CommandInput` + the durable stores. So this is a separate,
 * purpose-built registry — the single source for the palette, the `/help` list, and the unknown-slash hint, so
 * those three can never disagree. The set is deliberately small and **alias-free**.
 *
 * **One table** ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7, MVP-11 Step 2.2): one
 * {@link CommandDefinition} per command name, with a {@link Placement} per surface (`home`, `standalone-chat`, `home-chat`) that carries the group, the
 * rank, the words, the surface class and an availability function. Everything else here is DERIVED from it: the per-surface lists, the
 * `/help` text, the typed dispatch's lookup. The module is pure data and imports nothing from `ink`, `react` or `node:`.
 */

import { CHAT_MODES, REASONING_EFFORTS } from '@relavium/shared';

import type { Surface } from '../render/surface.js';
import { keyToken } from '../render/tui/legend.js';
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
  /**
   * `/agent` ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3, MVP-8 step 5)
   * — show the agent THIS chat is bound to, read-only: its id and name, the provider and model the session runs on, the tool grant as the
   * definition declares it, the temperature, the reasoning effort and the head of the system prompt. The interactive hosts (the standalone
   * chat and the in-Home chat) intercept the command and open the report popup before it gets here ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
   * §10); this runs where there is no popup to open (a plain, `--json` or one-shot chat) and prints the same fields as a notice. Chat-only: the landing has
   * no session, so it answers the word itself (ADR-0140 §3) and never runs this.
   */
  readonly showAgent: () => void | Promise<void>;
  /** Show the session's cumulative cost as a notice (2.5.C S4; the per-model breakdown is 2.6.C). */
  /** `/cost`, and `/cost --release` — ADR-0074 §1's escape hatch, on the surface that renders the amount. */
  readonly showCost: (release?: boolean) => void | Promise<void>;
  /** Run the `/doctor` health check (2.5.C S5); `deep` adds the network/process tier (key + MCP validation). */
  readonly runDoctor: (deep: boolean) => void | Promise<void>;
  /** Set the reasoning-effort tier (ADR-0066). Receives the raw tier token (empty ⇒ show the current tier + options).
   *  Pushes the session override (no reseat); chat-only, like `/mode`. */
  readonly setReasoningEffort: (effortArg: string) => void | Promise<void>;
  /** `/thinking` (2.5.H) — toggle the collapsible reasoning ("thinking") panel's visibility. A pure UI-view flip
   *  (no session/engine effect); chat-only, like `/mode`/`/effort`. The keyboard `Ctrl+T` does the same. */
  readonly toggleReasoning: () => void | Promise<void>;
  /** Open the interactive, read-only list of this instance's recent tool calls. */
  readonly openDetails: () => void | Promise<void>;
  /**
   * `/permissions` where there is no popup to open ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
   * §2, ADR-0148 §10): a plain, `--json` or one-shot chat, which has no store and no one to ask. The interactive hosts route the command to
   * its popup before it gets here, as they do `/models`. The command takes no argument (the typed `--revoke` forms are gone, and the
   * zero-argument rule rejects a typed token before this runs). Chat-only: the bare Home opens its `/permissions` popup through its own controller.
   */
  readonly managePermissions: () => void | Promise<void>;
  /** Switch the chat mode (ADR-0057). Receives the raw mode-name token (empty ⇒ show the current mode + options).
   *  The surface parses + applies it (re-applying the turn policy on the same session) and reports the result. */
  readonly setMode: (modeArg: string) => void | Promise<void>;
  /** `/compact` (ADR-0062) — model-summarise the working context into a preamble (an LLM call). Async — the
   *  surface shows a "Summarizing…" notice while awaiting, then reports the token deltas + summary. */
  readonly compactHistory: () => void | Promise<void>;
  /** `/trim [n]` (ADR-0062) — deterministically drop older messages to the last `n` (default `[chat].max_messages`),
   *  no LLM call. Receives the raw `n` token (empty ⇒ use the config default). */
  readonly trimHistory: (nArg: string) => void | Promise<void>;
  /** `/clear` (ADR-0062 §7) — end THIS conversation (persisted, and continued with `/resume` on the Home) and start a
   *  FRESH session under a new `sessionId`. A destructive HOST-LEVEL lifecycle swap (no engine primitive), so its
   *  effect on the running REPL differs by surface: a live chat (standalone or in-Home) tears the current session
   *  down and swaps in a fresh one; the BARE Home (no live session) is dim, with the reason, and a typed `/clear` answers the same words.
   *  Interactive-only — a `--json` / plain non-TTY session rejects it (one machine stream is one session lifecycle).
   *  Its notice says the previous conversation is saved and where `/resume` is (`clearedNotice`), and names no id or shell command. */
  readonly clearSession: () => void | Promise<void>;
  /** `/models` (2.5.G S7, [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §10 · ADR-0059) — open the
   *  in-tree model picker over the merged live/static catalog. Offered on the bare Home and in a chat, with a surface-specific
   *  accept: the **Home** writes the NEXT session's default model ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md)),
   *  and a **live chat** rebinds the running session via a host-side reseat (ADR-0059). The interactive render layer
   *  (the ink `ChatApp` / the in-Home controller) INTERCEPTS a typed/palette `/models` to open the overlay, so this
   *  ctx handler runs ONLY on a non-interactive chat driver (plain/`--json`), where it surfaces an actionable hint;
   *  the bare Home wires the real picker. */
  readonly openModels: () => void | Promise<void>;
  /**
   * `/scrollback` (2.6.F Step 5d, [ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e)
   * — dump the transcript into the terminal's NATIVE scrollback, so the user can scroll, search, select and copy it
   * with the emulator's own tools. The alternate screen removes all of those (no scrollback; mouse reporting captures
   * click-drag), which is why this exists. Unlike `/models` it opens no overlay — it suspends the renderer via ink's
   * `suspendTerminal`, so BOTH interactive surfaces reach it through this ONE capability, with no render-layer
   * interception. A plain / `--json` driver (no ink tree) surfaces an actionable hint instead. Chat-only: the bare
   * Home has no transcript.
   */
  readonly dumpScrollback: () => void | Promise<void>;
  /** `/edit` (2.6.F Step 5d, ADR-0068 §e) — open the transcript READ-ONLY in `$EDITOR` for search + copy, via ink's
   *  `suspendTerminal`. Edits are never read back. Same surface story as {@link dumpScrollback}. */
  readonly editTranscript: () => void | Promise<void>;
  /** `/copy` (2.6.F Step 6e) — put the WHOLE transcript on the system clipboard over OSC 52. The UNWRAPPED document,
   *  unlike a mouse selection's visual rows. Suspends nothing; a single control write. */
  readonly copyTranscript: () => void | Promise<void>;
}

/** A flag a {@link ReplCommand} accepts after its name (e.g. `/doctor --deep`). Flags only — the curated set has
 *  no positionals; a future positional command would extend this, not work around it. */
export interface ReplArg {
  readonly flag: string;
  readonly description: string;
}

// ── The one table ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The surfaces a command can be offered on ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7): every
 * {@link Surface} but the shell (a command line has no palette): the bare Home, a stand-alone `relavium chat` (`standalone-chat`) and the chat
 * the Home hosts (`home-chat`). A command is placed on each of them separately: where it sits, what it says and whether it can act differ by
 * surface.
 */
export type PaletteSurface = Exclude<Surface, 'shell'>;

/** The groups of a palette: the Home's four and the chat's five. The order a surface draws them in is {@link SURFACE_GROUPS}. */
export type CommandGroup =
  | 'work'
  | 'setup'
  | 'check'
  | 'model'
  | 'context'
  | 'inspect'
  | 'takeaway'
  | 'end';

/**
 * The groups of each surface, in the order they are listed ([MVP-11 Appendix B](../../../../docs/roadmap/phases/mvp-11.md#appendix-b--palette-orders)):
 * on the Home *Work*, *Set up*, *Check*, *End*; in a chat *Model and behaviour*, *Context*, *Inspect*, *Take away*, *End*. Nothing is sorted by
 * name: intent order, with the commands that end something last.
 */
const SURFACE_GROUPS: Readonly<Record<PaletteSurface, readonly CommandGroup[]>> = Object.freeze({
  home: Object.freeze<CommandGroup[]>(['work', 'setup', 'check', 'end']),
  'standalone-chat': Object.freeze<CommandGroup[]>([
    'model',
    'context',
    'inspect',
    'takeaway',
    'end',
  ]),
  'home-chat': Object.freeze<CommandGroup[]>(['model', 'context', 'inspect', 'takeaway', 'end']),
});

/**
 * The class of surface a command's result takes ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §1): a
 * **popup** (a report, a setting or a flow the user asked for), a **screen** (long, browsable content the user works in) or an **instant** (a
 * one-line result with no surface of its own). The registry stores the class of every placement, so a command cannot be added without
 * declaring one. **Declared ahead of use (ADR-0145 §1, §7), read by tests until the popup step**: no host chooses a surface by it yet.
 */
export type SurfaceClass = 'popup' | 'screen' | 'instant';

/**
 * The state a palette row's availability is read from. The host fills it from CACHED state only: never from a port, the keychain or the
 * disk at render time. A field that is `undefined` is unknown, and **an unknown value reads as enabled**: a dim row is advisory, and the
 * handler re-validates when the command runs.
 *
 * The context is the one [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7 names, and the hosts fill all of
 * it. TODAY the availability functions read only `hasSession` (`/clear`) and `hasSavedSessions` (`/resume`); `hasKey` is read by the
 * palette's own lead rule (`buildPaletteEntries`: a keyless Home leads with `/providers`) and by no availability function. `surface` and
 * `turnRunning` are **declared ahead of use (ADR-0145 §1, §7), read by tests until the popup step**: {@link availabilityOf} sets `surface`,
 * the hosts fill `turnRunning`, and no availability function reads either yet.
 */
export interface AvailabilityContext {
  readonly surface: PaletteSurface;
  /** A conversation is live: true in a chat, false at the bare Home. */
  readonly hasSession?: boolean | undefined;
  /** At least one provider key is usable. */
  readonly hasKey?: boolean | undefined;
  /** There is a saved conversation to continue. Unknown while the Home's snapshot has not loaded. */
  readonly hasSavedSessions?: boolean | undefined;
  /** A turn is streaming. */
  readonly turnRunning?: boolean | undefined;
}

/** Whether a command can act now, and if not, the reason in words (a dim row reads `unavailable · <reason>`). */
export type Availability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

/** Where, in what words and with what behaviour a command is offered on ONE surface. */
export interface Placement {
  readonly group: CommandGroup;
  /** The position inside the group on this surface: lower first. Unique within a group. */
  readonly rank: number;
  /** The row's words on this surface (one per surface, because the meaning differs: `/exit` leaves Relavium, ends a chat or goes home). */
  readonly description: string;
  /** The class of surface the result takes: declared ahead of use (ADR-0145 §1, §7), read by tests until the popup step ({@link SurfaceClass}). */
  readonly surface: SurfaceClass;
  /** Absent ⇒ always available. */
  readonly available?: (ctx: AvailabilityContext) => Availability;
}

/** What a command runs over the live session's lifecycle capabilities: the validated post-name tokens (empty for a zero-arg command). */
export type CommandRun = (ctx: ReplCommandContext, args: readonly string[]) => void | Promise<void>;

/** What every command declares, whoever handles it. */
interface CommandBase {
  /** The slash name without the leading `/`. */
  readonly name: string;
  readonly label?: string;
  /** A forward annotation, shared with the shell manifest ({@link CommandEffect}). */
  readonly effect: CommandEffect;
  /** The flags this command accepts after its name (omitted ⇒ zero-arg). The dispatch rejects any other token. */
  readonly args?: readonly ReplArg[];
  /** A sentence appended to the dispatch's rejection of a token this command does not accept. */
  readonly rejectHint?: string;
  /** An optional single POSITIONAL value (e.g. `/mode plan`); `values` empty ⇒ any single token. */
  readonly positional?: { readonly name: string; readonly values: readonly string[] };
  readonly placements: Readonly<Partial<Record<PaletteSurface, Placement>>>;
}

/**
 * A command the live session's context runs: `run` over the capabilities of the surface (a chat's handlers, and the few the bare Home runs
 * over its own context).
 */
export interface ContextCommand extends CommandBase {
  readonly run: CommandRun;
  readonly opener?: undefined;
}

/**
 * A command the Home opens ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7: real open bindings instead of an
 * empty `run`). It has NO handler here: the Home controller opens it from its one table of words, keyed by this name, whether it was typed or
 * chosen in the palette. The marker is typed data, so a test holds the commands that carry it to the table, both ways
 * (`home-registry-dispatch.test.ts`), and a command added without a handler or this marker does not compile.
 */
export interface HomeOpenedCommand extends CommandBase {
  readonly opener: 'home';
  readonly run?: undefined;
}

/**
 * One command: what it is and who handles it, and the placements that say where it is offered. **One definition per name**: `/workflows`,
 * `/permissions` and `/help` are the same command on the Home and in a chat, with a placement each.
 */
export type CommandDefinition = ContextCommand | HomeOpenedCommand;

/**
 * One curated in-REPL command AS ONE SURFACE SEES IT: the definition with that surface's description, derived from {@link COMMAND_TABLE} so
 * the palette, `/help`, the unknown-slash hint and the typed dispatch can never disagree. `run` wires the slash name to a
 * {@link ReplCommandContext} capability.
 */
export interface ReplCommand {
  /** The slash name without the leading `/` (`exit`, `help`) — also the palette/help label key. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** A forward annotation, shared with the shell manifest ({@link CommandEffect}): `read` (no data change) /
   *  `write` (creates a file) / `destructive` (irreversibly removes — e.g. `/clear`, which ends the current session). */
  readonly effect: CommandEffect;
  /** The flags this command accepts after its name (omitted ⇒ zero-arg), e.g. `/doctor --deep`. The in-REPL dispatch
   *  (`createChatLineHandler`) splits the slash line into a name and tokens, rejects any token not listed here (so a
   *  zero-arg command still rejects `/exit now`) and passes the validated tokens to `run`. The `/` palette captures NO
   *  args: selecting a command submits the bare `/<name>`, so a flag is opt-in by typing it. Flags only, no positionals. */
  readonly args?: readonly ReplArg[];
  /** A sentence appended to the dispatch's rejection of a token this command does not accept: where a removed or mistyped form's job went. */
  readonly rejectHint?: string;
  /** An optional single POSITIONAL value the command accepts (e.g. `/mode plan`) — the dispatch accepts a token
   *  in `values` (in addition to any declared flags) and rejects anything else, so an invalid value is caught
   *  before `run`. The palette still submits the BARE `/<name>` (no positional), so `run` handles the empty arg. */
  readonly positional?: { readonly name: string; readonly values: readonly string[] };
  /** Run the command; receives the validated post-name arg tokens (empty for a zero-arg command). May be async
   *  (an awaited `Promise<void>`), so `/cost` / `/doctor` are safe. A {@link HomeOpenedCommand} has no handler to run: its `run` throws, so
   *  a route that reached it by mistake fails loudly instead of doing nothing. */
  readonly run: CommandRun;
}

const ENABLED: Availability = Object.freeze({ enabled: true });
const unavailable = (reason: string): Availability => Object.freeze({ enabled: false, reason });

/** The Home has no conversation: `/clear` there is shown, dim, with this reason (ADR-0145 §7.4). */
const NO_CONVERSATION_TO_CLEAR = 'no conversation to clear';
/** `/resume` with no saved conversation is dim: the picker would be empty. */
const NOTHING_TO_RESUME = 'nothing to resume';

const clearNeedsAConversation = (ctx: AvailabilityContext): Availability =>
  ctx.hasSession === false ? unavailable(NO_CONVERSATION_TO_CLEAR) : ENABLED;
const resumeNeedsASavedSession = (ctx: AvailabilityContext): Availability =>
  ctx.hasSavedSessions === false ? unavailable(NOTHING_TO_RESUME) : ENABLED;

/**
 * The two chat placements of one command: a stand-alone chat and the chat the Home hosts differ only where a row says so (`/exit` says where it
 * goes, `/resume` exists only in the Home's). `homeChat` overrides what differs.
 */
function inChats(
  placement: Placement,
  homeChat: Partial<Placement> = {},
): Readonly<Record<CommandListSurface, Placement>> {
  return { 'standalone-chat': placement, 'home-chat': { ...placement, ...homeChat } };
}

/** What `/doctor` says in the palette, on every surface that has it: the Home too opens the deep tier on its confirmation line (ADR-0148 §8). */
const DOCTOR_DESCRIPTION = 'Check your setup; --deep also validates keys and MCP.';

/** The `run` of a {@link HomeOpenedCommand} in the flattened view: the Home opens the command itself, so a call here is a routing mistake. */
const refuseToRun =
  (name: string): CommandRun =>
  () => {
    throw new Error(`/${name} is opened by the Home, not run over a session`);
  };

/**
 * The commands. Order here is NOT the palette's order: each surface lists its commands by (group, rank) ({@link commandsOf}), so a command is
 * added where it reads best and the tests pin the result.
 */
const COMMAND_TABLE: readonly CommandDefinition[] = [
  {
    name: 'help',
    label: 'Help',
    // `/help` is a popup on the Home (the keys and the commands on one page, ADR-0148 §10 as amended 2026-11-27, MVP-11 unit 8) and in a chat.
    effect: 'read',
    run: (ctx) => ctx.help(),
    placements: {
      home: {
        group: 'check',
        rank: 20,
        description: 'List the available slash commands.',
        surface: 'popup',
      },
      ...inChats({
        group: 'inspect',
        rank: 60,
        description: 'List the available slash commands.',
        surface: 'popup',
      }),
    },
  },
  {
    name: 'exit',
    label: 'Exit',
    effect: 'read',
    run: (ctx) => ctx.exit(),
    placements: {
      home: { group: 'end', rank: 20, description: 'Leave Relavium.', surface: 'instant' },
      ...inChats(
        { group: 'end', rank: 30, description: 'End the chat session.', surface: 'instant' },
        { description: 'Leave this chat and go back to the Home.' },
      ),
    },
  },
  {
    name: 'cancel',
    label: 'Cancel',
    effect: 'read',
    run: (ctx) => ctx.cancel(),
    placements: inChats({
      group: 'end',
      rank: 20,
      description: 'Cancel the current turn and end the (resumable) session.',
      surface: 'instant',
    }),
  },
  {
    name: 'export',
    label: 'Export session',
    effect: 'write',
    run: (ctx) => ctx.exportSession(),
    placements: inChats({
      group: 'takeaway',
      rank: 20,
      description: 'Scaffold the session so far to a .relavium.yaml.',
      surface: 'popup',
    }),
  },
  {
    name: 'agent',
    label: 'Agent',
    // `read`: it shows the definition the session already holds, and reads and writes nothing. Zero-arg: the dispatch rejects any token.
    // Typing `agent` in the palette selects this one first: an exact name leads, and `/workflows`' description also says "agents".
    effect: 'read',
    run: (ctx) => ctx.showAgent(),
    placements: inChats({
      group: 'inspect',
      rank: 30,
      description: 'Show the agent this chat is bound to.',
      surface: 'popup',
    }),
  },
  {
    name: 'workflows',
    label: 'Workflows',
    // Two behaviours under one name: a chat lists what the project holds; the Home opens the catalogue popup, with a detail step (ADR-0148 §10 as amended 2026-11-27).
    effect: 'read',
    run: (ctx) => ctx.showWorkflows(),
    placements: {
      home: {
        group: 'work',
        rank: 30,
        description: 'The workflows of this project: run or export one.',
        surface: 'popup',
      },
      ...inChats({
        group: 'inspect',
        rank: 40,
        description: 'List the workflows and agents discovered in this project.',
        surface: 'popup',
      }),
    },
  },
  {
    name: 'cost',
    label: 'Cost',
    // `read` for the bare form. `--release` MUTATES (ADR-0074 §1's deliberate user decision), but the flag is
    // opt-in by typing it — the palette submits the bare form, exactly like `/doctor --deep`.
    effect: 'read',
    args: [
      {
        flag: '--release',
        description:
          'Clear conservative commitments — estimates held against the cap for calls that returned no usage.',
      },
    ],
    run: (ctx, args) => ctx.showCost(args.includes('--release')),
    placements: inChats({
      group: 'inspect',
      rank: 10,
      description: "Show this session's cumulative cost; --release clears held estimates.",
      surface: 'popup',
    }),
  },
  {
    name: 'doctor',
    label: 'Doctor',
    effect: 'read',
    args: [
      {
        flag: '--deep',
        description: 'Also validate provider keys and MCP connectivity (network).',
      },
    ],
    // The palette runs the fast tier (`deep: false`); `--deep` is opt-in by typing it. `/doctor` is a REAL Home capability (pre-chat
    // diagnostics), so it is placed on every surface. On every interactive surface the hosts open the `/doctor` popup before this runs
    // (ADR-0148 §8), and a typed `--deep` opens it on its confirmation line, on the Home too, so the one description names `--deep` on every
    // surface. A plain, `--json` or one-shot chat runs this and prints the text report.
    run: (ctx, args) => ctx.runDoctor(args.includes('--deep')),
    placements: {
      home: { group: 'check', rank: 10, description: DOCTOR_DESCRIPTION, surface: 'popup' },
      ...inChats({
        group: 'inspect',
        rank: 50,
        description: DOCTOR_DESCRIPTION,
        surface: 'popup',
      }),
    },
  },
  {
    name: 'mode',
    label: 'Mode',
    effect: 'read',
    // A single positional mode name; the dispatch validates it against these values, so `run` only ever sees a
    // valid mode or an empty arg (the palette's bare `/mode` — which shows the current mode + the options).
    positional: { name: 'mode', values: [...CHAT_MODES] },
    run: (ctx, args) => ctx.setMode(args[0] ?? ''),
    placements: {
      // The Home has no conversation for Shift+Tab to change: its form sets the startup default.
      home: {
        group: 'setup',
        rank: 30,
        description: 'Choose the mode new chats start in.',
        surface: 'popup',
      },
      ...inChats({
        group: 'model',
        rank: 20,
        description: `Choose the mode; ${keyToken('Shift+Tab')} changes this chat only.`,
        surface: 'popup',
      }),
    },
  },
  {
    name: 'effort',
    label: 'Effort',
    effect: 'read',
    // A single positional tier, validated by the dispatch against these values; bare `/effort` shows the current
    // tier + the options. A per-turn session override (no reseat) — chat-only, like `/mode`.
    positional: { name: 'effort', values: [...REASONING_EFFORTS] },
    run: (ctx, args) => ctx.setReasoningEffort(args[0] ?? ''),
    placements: inChats({
      group: 'model',
      rank: 30,
      description: 'Set the reasoning-effort tier: off / low / medium / high / max.',
      surface: 'popup',
    }),
  },
  {
    name: 'thinking',
    label: 'Thinking',
    // Zero-arg toggle: a pure UI-view flip of the reasoning panel (2.5.H), no session effect. Chat-only (reasoning
    // streams only in a live turn), like `/mode` / `/effort`.
    effect: 'read',
    run: (ctx) => ctx.toggleReasoning(),
    placements: inChats({
      group: 'model',
      rank: 40,
      description: `Show or hide the reasoning ("thinking") panel (or ${keyToken('Ctrl+T')} to toggle).`,
      surface: 'instant',
    }),
  },
  {
    name: 'details',
    label: 'Tool details',
    effect: 'read',
    run: (ctx) => ctx.openDetails(),
    placements: inChats({
      group: 'inspect',
      rank: 20,
      description: 'Inspect recent tool calls and their available previews.',
      surface: 'popup',
    }),
  },
  {
    name: 'compact',
    label: 'Compact',
    effect: 'write',
    run: (ctx) => ctx.compactHistory(),
    placements: inChats({
      group: 'context',
      rank: 20,
      description: 'Summarise the conversation so far to reclaim context (spends tokens).',
      surface: 'instant',
    }),
  },
  {
    name: 'permissions',
    label: 'Permissions',
    // `read`: opening it changes nothing; a withdrawal is a keypress inside it (the chat's popup, the Home's tab), never a typed argument.
    effect: 'read',
    rejectHint: `Open /permissions and press ${keyToken('d')} on a row to withdraw it.`,
    run: (ctx) => ctx.managePermissions(),
    placements: {
      // The bare Home's `/permissions` (ADR-0137 §3, MVP-11 unit 8): a popup with the project's remembered commands and the repository's allowlist.
      home: {
        group: 'setup',
        rank: 40,
        description: `Remembered commands for this project; ${keyToken('d')} withdraws one.`,
        surface: 'popup',
      },
      ...inChats({
        group: 'model',
        rank: 50,
        description: `See the commands remembered for this project and approved for this session; ${keyToken('d')} withdraws one.`,
        surface: 'popup',
      }),
    },
  },
  {
    name: 'trim',
    label: 'Trim',
    effect: 'read',
    // An optional numeric bound; a FREE positional (empty `values`) accepts any single token — `run` validates it.
    positional: { name: 'n', values: [] },
    run: (ctx, args) => ctx.trimHistory(args[0] ?? ''),
    placements: inChats({
      group: 'context',
      rank: 10,
      description:
        'Deterministically drop older messages (no LLM call); /trim [n], default [chat].max_messages.',
      surface: 'instant',
    }),
  },
  {
    name: 'clear',
    label: 'Clear',
    // `destructive` in the forward taxonomy (ADR-0062 §7): it ends the current session — still persisted + resumable — and swaps in a fresh
    // one under a new sessionId. Listed on the bare Home too, DIM with its reason (ADR-0145 §7.4): the Home has no conversation to clear.
    // Zero-arg (`/clear x` rejects).
    effect: 'destructive',
    run: (ctx) => ctx.clearSession(),
    placements: {
      home: {
        group: 'end',
        rank: 10,
        description: 'End this conversation (saved + resumable) and start a fresh session.',
        surface: 'instant',
        available: clearNeedsAConversation,
      },
      ...inChats({
        group: 'end',
        rank: 10,
        description: 'End this conversation (saved + resumable) and start a fresh session.',
        surface: 'instant',
      }),
    },
  },
  {
    name: 'models',
    label: 'Models',
    // `read` in the forward taxonomy: opening the popup changes nothing; the action happens only on an explicit answer — the Home writes
    // the NEXT session's default (ADR-0063), the chat reseats the LIVE session (ADR-0059) or writes the default. In an interactive chat the
    // host's routing opens the popup for a typed `/models` (ADR-0148 §3); a plain/`--json` chat (no popup) falls through to `openModels`,
    // which surfaces an actionable hint.
    effect: 'read',
    run: (ctx) => ctx.openModels(),
    placements: {
      home: {
        group: 'setup',
        rank: 20,
        description: 'Choose the model new chats start with.',
        surface: 'popup',
      },
      ...inChats({
        group: 'model',
        rank: 10,
        description: 'Choose the model and effort for this chat or new chats.',
        surface: 'popup',
      }),
    },
  },
  {
    name: 'scrollback',
    label: 'Scrollback',
    // `read` in the forward taxonomy: it prints, and changes nothing. It reaches the live chat on both surfaces through the ONE
    // `ReplCommandContext` capability: unlike `/models` it opens no React overlay, so no render-layer interception is needed (ADR-0068 §e).
    effect: 'read',
    run: (ctx) => ctx.dumpScrollback(),
    placements: inChats({
      group: 'takeaway',
      rank: 40,
      description: 'Dump the transcript into the terminal’s native scrollback (to copy or search).',
      surface: 'instant',
    }),
  },
  {
    name: 'edit',
    label: 'Edit',
    // `read`: the editor gets a throwaway copy; edits are never read back into the session.
    effect: 'read',
    run: (ctx) => ctx.editTranscript(),
    placements: inChats({
      group: 'takeaway',
      rank: 30,
      description: 'Open the transcript in $EDITOR (read-only — to search or copy).',
      surface: 'instant',
    }),
  },
  {
    name: 'copy',
    label: 'Copy',
    // `read`: it sends bytes to the terminal, and changes nothing in the session.
    effect: 'read',
    run: (ctx) => ctx.copyTranscript(),
    placements: inChats({
      group: 'takeaway',
      rank: 10,
      description: 'Copy the whole transcript to the system clipboard (OSC 52).',
      surface: 'instant',
    }),
  },
  // ── The Home's own commands: the controller opens each from its table of words (`opener: 'home'`), so there is no `run` ─────
  {
    name: 'providers',
    label: 'Providers',
    // Project and environment configuration is Home-only (ADR-0145 §7.5, OD-2): both Home surfaces intercept it and open the shared setup.
    effect: 'read',
    opener: 'home',
    placements: {
      home: {
        group: 'setup',
        rank: 10,
        description: 'Connect, login, or manage provider API keys.',
        surface: 'popup',
      },
    },
  },
  {
    name: 'init',
    label: 'Initialize project',
    effect: 'write',
    opener: 'home',
    placements: {
      home: {
        group: 'setup',
        rank: 60,
        description: 'Initialize project workflow and agent directories after confirmation.',
        surface: 'popup',
      },
    },
  },
  {
    name: 'import',
    label: 'Import file',
    // The card over `relavium import`'s own core, which writes a file only on a Yes and never overwrites (ADR-0140 §9).
    effect: 'write',
    opener: 'home',
    placements: {
      home: {
        group: 'setup',
        rank: 70,
        description: 'Bring a YAML file into this project, after confirmation.',
        surface: 'popup',
      },
    },
  },
  {
    name: 'pricing',
    label: 'Model pricing',
    // The form over the shell's own pricing core, which records a price only on a Yes (ADR-0140 §9).
    effect: 'write',
    opener: 'home',
    placements: {
      home: {
        group: 'setup',
        rank: 50,
        description: 'Set or clear your own price for a model.',
        surface: 'popup',
      },
    },
  },
  {
    name: 'resume',
    label: 'Resume session',
    // The Home and the chat it hosts have it (a stand-alone chat has no Home to go back to). Dim when there is nothing to continue.
    effect: 'read',
    opener: 'home',
    placements: {
      home: {
        group: 'work',
        rank: 10,
        description: 'Search saved conversations and continue one.',
        surface: 'popup',
        available: resumeNeedsASavedSession,
      },
      'home-chat': {
        group: 'end',
        rank: 5,
        description: 'Search saved conversations and continue one.',
        surface: 'popup',
        available: resumeNeedsASavedSession,
      },
    },
  },
  {
    name: 'run',
    label: 'Run workflow',
    // A picker over the project's workflows, the launch form and a confirmation that defaults to No (ADR-0139 §7). Home only.
    effect: 'write',
    opener: 'home',
    placements: {
      home: {
        group: 'work',
        rank: 20,
        description: 'Pick a workflow, fill in its inputs and run it after confirmation.',
        surface: 'popup',
      },
    },
  },
  {
    name: 'agents',
    label: 'Agents',
    // The agents popup, a list and a detail (ADR-0148 §10 as amended 2026-11-27). A Home command only: a live chat has no `/agents`.
    effect: 'read',
    opener: 'home',
    placements: {
      home: {
        group: 'work',
        rank: 40,
        description: 'The agents of this project: start a chat with one.',
        surface: 'popup',
      },
    },
  },
];

const ORDER_BY_SURFACE: Readonly<Record<PaletteSurface, readonly CommandDefinition[]>> = (() => {
  const orderOf = (surface: PaletteSurface): readonly CommandDefinition[] => {
    const groups = SURFACE_GROUPS[surface];
    const placed = COMMAND_TABLE.flatMap((definition) => {
      const placement = definition.placements[surface];
      return placement === undefined ? [] : [{ definition, placement }];
    });
    placed.sort(
      (a, b) =>
        groups.indexOf(a.placement.group) - groups.indexOf(b.placement.group) ||
        a.placement.rank - b.placement.rank,
    );
    return placed.map((entry) => entry.definition);
  };
  return {
    home: orderOf('home'),
    'standalone-chat': orderOf('standalone-chat'),
    'home-chat': orderOf('home-chat'),
  };
})();

/** DEEP-freeze a definition — the entry, its `args` array + each flag, its `positional` and its placements — so no downstream code can mutate
 *  the registry at runtime. Parity with `COMMAND_MANIFEST`'s `freezeEntry`. */
function freezeDefinition(definition: CommandDefinition): CommandDefinition {
  if (definition.args !== undefined) {
    definition.args.forEach((arg) => Object.freeze(arg));
    Object.freeze(definition.args);
  }
  if (definition.positional !== undefined) {
    Object.freeze(definition.positional.values);
    Object.freeze(definition.positional);
  }
  for (const placement of Object.values(definition.placements)) Object.freeze(placement);
  Object.freeze(definition.placements);
  return Object.freeze(definition);
}

/** The deep-frozen table: one definition per command name, with its placements. */
const COMMAND_DEFINITIONS: readonly CommandDefinition[] = Object.freeze(
  COMMAND_TABLE.map(freezeDefinition),
);

/** O(1) lookup of a definition by its slash name (no leading `/`). */
const COMMAND_DEFINITIONS_BY_NAME: ReadonlyMap<string, CommandDefinition> = new Map(
  COMMAND_DEFINITIONS.map((definition) => [definition.name, definition]),
);

/**
 * The definitions a surface offers, in the order it lists them: by the surface's group order, then by rank. **The one export of the table that
 * no production file reads**: `repl-registry.test.ts` and `home-registry-dispatch.test.ts` hold the table to its contract through it (its
 * placements, its `opener` marker, its order), and the popup step reads the placements' classes from it.
 */
export function commandDefinitionsOf(surface: PaletteSurface): readonly CommandDefinition[] {
  return ORDER_BY_SURFACE[surface];
}

/** A command's placement on a surface, or `undefined` when that surface does not offer it. */
export function placementOf(name: string, surface: PaletteSurface): Placement | undefined {
  return COMMAND_DEFINITIONS_BY_NAME.get(name)?.placements[surface];
}

/**
 * Whether a command can act on a surface given the cached state. A command with no availability function is always available, and a
 * command the surface does not offer is not available there. An unknown value in the context reads as enabled.
 */
export function availabilityOf(
  name: string,
  surface: PaletteSurface,
  ctx: Omit<AvailabilityContext, 'surface'>,
): Availability {
  const placement = placementOf(name, surface);
  if (placement === undefined) return unavailable('not offered here');
  return placement.available?.({ ...ctx, surface }) ?? ENABLED;
}

const replCommandCache = new Map<string, ReplCommand>();

/** A definition as one surface sees it, flattened to a {@link ReplCommand}. The same object every time for one (name, surface). */
function replCommandFor(definition: CommandDefinition, surface: PaletteSurface): ReplCommand {
  const key = `${surface}:${definition.name}`;
  const cached = replCommandCache.get(key);
  if (cached !== undefined) return cached;
  const placement = definition.placements[surface];
  if (placement === undefined) throw new Error(`/${definition.name} has no ${surface} placement`);
  const command: ReplCommand = Object.freeze({
    name: definition.name,
    label: definition.label ?? definition.name,
    description: placement.description,
    effect: definition.effect,
    ...(definition.args === undefined ? {} : { args: definition.args }),
    ...(definition.rejectHint === undefined ? {} : { rejectHint: definition.rejectHint }),
    ...(definition.positional === undefined ? {} : { positional: definition.positional }),
    run: definition.run ?? refuseToRun(definition.name),
  });
  replCommandCache.set(key, command);
  return command;
}

/** The commands a surface offers, as that surface sees them, in the order it lists them. */
export function commandsOf(surface: PaletteSurface): readonly ReplCommand[] {
  return ORDER_BY_SURFACE[surface].map((definition) => replCommandFor(definition, surface));
}

/**
 * The curated command set of a stand-alone chat, in its palette's order — the single source for the typed dispatch of every chat and for a
 * stand-alone chat's `/help` and unknown-slash hint (the palette's own rows come from {@link commandsOf} through `buildPaletteEntries`). The
 * plain, `--json` and one-shot drivers run the same handlers and print this order in their `/help`, which is accepted and recorded (ADR-0145
 * §7.7). The chat the Home hosts runs the same handlers but lists {@link HOME_CHAT_PALETTE_COMMANDS} (`formatReplHelp('home-chat')`).
 */
export const REPL_COMMANDS: readonly ReplCommand[] = Object.freeze(commandsOf('standalone-chat'));

/** O(1) lookup of a chat's REPL command by its slash name (no leading `/`). The `ReadonlyMap` type is the mutation guard
 *  (a `Map`'s internal data can't be `Object.freeze`d); every command it holds is deep-frozen above. */
export const REPL_COMMANDS_BY_NAME: ReadonlyMap<string, ReplCommand> = new Map(
  REPL_COMMANDS.map((command) => [command.name, command]),
);

/**
 * The commands the `/` palette of the chat the Home hosts offers: a chat's list plus `/resume`, without `/providers` and `/init` (OD-2). A
 * stand-alone chat's palette offers {@link REPL_COMMANDS} (with `/help` in it since MVP-11 Step 2.2, ADR-0145 §7.3: the keys that only `/help`
 * lists, such as `Shift+Tab` and `Ctrl+J`, are otherwise undiscoverable), and the palette builds its rows from {@link commandsOf}.
 */
export const HOME_CHAT_PALETTE_COMMANDS: readonly ReplCommand[] = Object.freeze(
  commandsOf('home-chat'),
);

/** The commands the bare Home's `/` palette offers, in its order (the keyless lead is the palette's own, state-aware rule). */
export const HOME_PALETTE_COMMANDS: readonly ReplCommand[] = Object.freeze(commandsOf('home'));

/**
 * The one line a chat answers to a command that only the Home has (ADR-0145 §7.4): it names the surface that has the command, opens
 * nothing and is not "unknown command". `undefined` when the surface offers the command, when no command has that name and when no surface
 * but a chat has it (the Home answers a chat's word itself, with its own sentence). A stand-alone chat (`standalone-chat`) is not inside the Home, so its
 * line also says how to reach it; the chat the Home hosts (`home-chat`) is, and its line only names it.
 */
export function homeOnlyPointer(name: string, surface: PaletteSurface): string | undefined {
  if (surface === 'home') return undefined;
  const definition = COMMAND_DEFINITIONS_BY_NAME.get(name);
  if (definition === undefined || definition.placements[surface] !== undefined) return undefined;
  if (definition.placements.home === undefined) return undefined;
  return surface === 'standalone-chat'
    ? `/${name} is available from the Home: start Relavium without arguments.`
    : `/${name} is available from the Home.`;
}

/** What a host says when the palette's Enter lands on a dim row: the row's own reason, as a sentence, never "unknown command". */
export function unavailableNotice(name: string, reason: string): string {
  return `/${name} is unavailable: ${reason}.`;
}

/** The two surfaces that print a command list: a stand-alone chat (every non-interactive driver too) and the chat the Home hosts. */
export type CommandListSurface = Extract<Surface, 'home-chat' | 'standalone-chat'>;

/**
 * The comma-separated slash list for the unknown-slash hint — `/models, /mode, /effort, …`, in the order the surface's palette lists them. A
 * stand-alone chat (the default, and what the plain, `--json` and one-shot drivers print) and the chat the Home hosts differ by `/resume`.
 */
export function replCommandList(surface: CommandListSurface = 'standalone-chat'): string {
  return commandsOf(surface)
    .map((command) => `/${command.name}`)
    .join(', ');
}

/**
 * The multi-line `/help` body — one line per command (`/name  description`), in the surface's palette order and with the surface's words
 * (`/exit` reads "End the chat session." in a stand-alone chat and "Leave this chat and go back to the Home." in the Home's), so `/help` and
 * the palette cannot disagree.
 */
export function formatReplHelp(surface: CommandListSurface = 'standalone-chat'): string {
  const rows = commandsOf(surface).map((command) => `  /${command.name}  ${command.description}`);
  return `Commands:\n${rows.join('\n')}\n`;
}
