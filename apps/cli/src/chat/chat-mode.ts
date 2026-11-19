import type {
  ConfirmActionHook,
  SessionTurnPolicy,
  ToolActionPreview,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolDef,
  ToolDenialClass,
  ToolApprovalLiveContext,
  ToolLiveObserver,
} from '@relavium/core';
import { CHAT_MODES, type AbortSignalLike, type ChatMode } from '@relavium/shared';

import { commandCardFacts, type CommandCardFacts } from './command-facts.js';

export { CHAT_MODES } from '@relavium/shared';
export type { ChatMode } from '@relavium/shared';

/**
 * The CLI chat **mode** model (2.5.E Step 4, [ADR-0057](../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)).
 * A mode is a POLICY LAYER on the one session instance — never a reseat: it maps to a
 * {@link SessionTurnPolicy} the host pushes via `AgentSession.setTurnPolicy`, controlling only (a) the
 * model-advertised tool subset and (b) the per-dispatch approval decision. The engine stays mode-agnostic;
 * this module maps the shared ask / plan / accept-edits / auto vocabulary to those policies.
 *
 * Two-layer safety (ADR-0057): the advertise-filter is BEST-EFFORT (it keeps a governed tool out of the
 * model's reach), while the `confirm` hook is AUTHORITATIVE — the registry calls it for every governed-class
 * dispatch (fs_write / egress / a model-controlled process), so even if the model names a hidden tool the
 * mode policy still decides. Per [ADR-0130](../../../../docs/decisions/0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md):
 * `ask` prompts (`Ctrl+Y`/`Ctrl+G`/`Ctrl+N`) before every governed action, with a session once/always memory; `plan` is
 * read-only — governed tools are hidden and a call that arrives anyway is refused with a fixed message that
 * RETURNS to the model (ADR-0117), so the turn continues; `accept-edits` applies file edits (inside the
 * workspace or a root the operator authorised) without a card (the write is never silent — its row keeps the target and diff stats) but still
 * prompts for commands, network and ambient OS actions; `auto` auto-approves every granted governed action.
 * A protected path is not a prompt in any mode: the fs layer refuses it while the write is being prepared,
 * before any card exists — the floor beneath every mode. The protected-target branches in {@link confirmFor}
 * (a prompt that is never offered "always") are a defensive fallback behind that refusal, not a path a
 * person is expected to see.
 */

/** The default mode: `ask` (secure by default — no governed action without the person's explicit, previewed answer). */
export const DEFAULT_CHAT_MODE: ChatMode = 'ask';

/** Short labels for the footer indicator + `/mode` output. Kept identical to the mode ids (kebab, no spaces)
 *  so the footer's `accept-edits mode` is exactly what `/mode accept-edits` accepts — display + input agree. */
export const MODE_LABEL: Record<ChatMode, string> = {
  ask: 'ask',
  plan: 'plan',
  'accept-edits': 'accept-edits',
  auto: 'auto',
};

/** One-line descriptions, listed by the bare `/mode` output (the chat command's mode-discovery affordance). */
export const MODE_DESCRIPTION: Record<ChatMode, string> = {
  ask: 'asks before each write, command or network call — the default',
  plan: 'read-only — nothing is changed; the agent drafts a plan first',
  'accept-edits':
    'applies file edits without asking; still asks for commands and network; refuses protected paths',
  auto: 'approves granted actions; scope and protected-path rules still apply',
};

/** The fixed label the mode refusal carries to the model (ADR-0117 §2): the mode's name, never a target. */
const PLAN_REFUSAL = 'plan mode is read-only';

/** The next mode in the `Shift+Tab` cycle: ask → plan → accept-edits → auto → ask. */
export function nextMode(mode: ChatMode): ChatMode {
  const index = CHAT_MODES.indexOf(mode);
  return CHAT_MODES[(index + 1) % CHAT_MODES.length] ?? DEFAULT_CHAT_MODE;
}

/**
 * Parse a mode name to a {@link ChatMode}. Case-insensitive; it also normalizes internal whitespace to a
 * hyphen (`accept edits` → `accept-edits`) as a DEFENSIVE convenience for any direct caller — note the `/mode`
 * slash dispatch tokenizes on whitespace, so a spaced value never reaches here as one token (the labels are
 * kebab, so a user types `accept-edits`); the normalization only matters to a programmatic caller.
 */
export function parseMode(input: string): ChatMode | undefined {
  const normalized = input.trim().toLowerCase().replace(/\s+/gu, '-');
  return isChatMode(normalized) ? normalized : undefined;
}

/** A type guard that narrows a string to {@link ChatMode} via the {@link CHAT_MODES} tuple — no `as` cast. */
function isChatMode(value: string): value is ChatMode {
  return CHAT_MODES.some((mode) => mode === value);
}

/**
 * The REPL's interactive answer to an approval prompt — RICHER than the engine's approve/reject because it
 * carries the once/always SCOPE (the engine only needs the final approve/reject). `always` is remembered for
 * the tool id for the rest of the session instance; `once` approves just this invocation.
 */
export type ApprovalAnswer =
  | { readonly outcome: 'approve'; readonly scope: 'once' | 'always' | 'remember' }
  | {
      readonly outcome: 'reject';
      readonly reason?: string;
      /** Why no one said yes — `user` (the default) or `unavailable` (no one can answer). See ADR-0117. */
      readonly denialClass?: ToolDenialClass;
    };

/**
 * The interactive prompt the REPL supplies (accept-edits, and auto's protected-path fallback). `cacheable`
 * tells the REPL whether an "always" answer will actually be REMEMBERED for the session: `true` in accept-edits
 * (offer "always"), `false` at auto's protected-path fallback (a protected prompt re-asks every time, so the
 * REPL should grey out / omit the `always` choice rather than silently discard it). It is a UX signal only —
 * the `toDecision` floor still enforces the same rule if a prompt returns `always` anyway.
 *
 * For a command, `facts` is what its card says and offers (ADR-0118 §1): `always` then means THIS exact command for the
 * session and `remember` means this exact command for this project; the hook narrows any answer the card did not offer.
 */
export type ApprovalPrompt = (
  request: ToolApprovalRequest,
  cacheable: boolean,
  signal?: AbortSignalLike,
  live?: ToolApprovalLiveContext,
  facts?: CommandCardFacts,
) => Promise<ApprovalAnswer>;

/**
 * The canonical fail-closed {@link ApprovalPrompt} for a NON-INTERACTIVE surface (Step 14 — the one home for the
 * no-TTY policy, previously hand-rolled in `chat.ts` and `agent-run.ts`). When there is no user at a TTY to answer
 * an interactive consent prompt — a plain non-TTY / `--json` chat, or a one-shot `agent run` — a governed dispatch
 * must be DENIED immediately: never a hang (an unanswerable `store.requestApproval` promise), and never an
 * auto-approve (that would be the "bypass all permissions" valve ADR-0057 forbids). So every request resolves to a
 * reject, regardless of the tool / mode; the `context` names the surface in the secret-free denial reason. This is
 * the ADR-0057 fail-closed floor with no interactive answerer — the model-facing outcome is the same `tool_denied`.
 */
export function nonInteractiveApprovalPrompt(context: string): ApprovalPrompt {
  const reason = `interactive approval is unavailable ${context}`;
  return () => Promise.resolve({ outcome: 'reject', reason, denialClass: 'unavailable' });
}

/**
 * The session-scoped, IN-MEMORY once/always cache (ADR-0057 — NOT persisted across resume, so a `chat-resume`
 * re-prompts). `always` = a tool id approved for the remainder of this session instance; `once` caches
 * nothing (it approves a single invocation, then the next identical call re-prompts).
 */
export class ApprovalCache {
  readonly #always = new Set<string>();
  /** Commands approved for the rest of this session, keyed by their exact argv (see {@link isAlwaysCommand}). */
  readonly #commands = new Map<string, string | undefined>();
  /** Whether this tool id was previously "always"-approved this session. */
  isAlways(toolId: string): boolean {
    return this.#always.has(toolId);
  }
  /** Remember an "always" approval for a tool id (the remainder of this session instance). */
  rememberAlways(toolId: string): void {
    this.#always.add(toolId);
  }
  /**
   * Whether this EXACT argv was approved for the rest of this session ([ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md)
   * §2). A command is never approved by tool id: "allow `run_command` this session" would approve every later command, so the
   * cache for a command is keyed by the argv, element by element (`["cat","a b"]` and `["cat","a","b"]` are different). Held in
   * memory only; never persisted, so a resumed session asks again.
   */
  isAlwaysCommand(argv: readonly string[]): boolean {
    return this.#commands.has(JSON.stringify(argv));
  }
  /** Remember one exact argv for the remainder of this session instance. */
  rememberAlwaysCommand(argv: readonly string[], grantId?: string): void {
    this.#commands.set(JSON.stringify(argv), grantId);
  }
  /**
   * Take back the session approvals that a *Remember* created for the remembered grant `grantId`, so withdrawing that grant makes the
   * command ask again in THIS chat too (the session approval a Remember adds would otherwise keep it running). The number withdrawn.
   */
  forgetCommandsByGrant(grantId: string): number {
    let removed = 0;
    for (const [key, id] of this.#commands) {
      if (id !== grantId) continue;
      this.#commands.delete(key);
      removed += 1;
    }
    return removed;
  }
  /** The commands approved for this session, in the order they were approved (`/permissions` numbers them from 1). */
  commandApprovals(): readonly (readonly string[])[] {
    const argvs: (readonly string[])[] = [];
    for (const key of this.#commands.keys()) {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.every((element) => typeof element === 'string'))
        argvs.push(parsed);
    }
    return argvs;
  }
  /** Take back the session approval at the 1-based `index` of {@link commandApprovals}; the argv it was, or `undefined` when none. */
  forgetCommandApproval(index: number): readonly string[] | undefined {
    const target = this.commandApprovals()[index - 1];
    if (target === undefined) return undefined;
    this.#commands.delete(JSON.stringify(target));
    return target;
  }
}

/**
 * Whether a tool is a mutating/side-effecting action the `plan` advertise-filter HIDES. It is a superset
 * of the registry's runtime `confirmAction` `governedAction`: it also hides a `requiresGateApproval` tool
 * (`git_commit`), which `confirmAction` does NOT gate (its `enforcePolicy` human-gate floor denies it on the
 * chat path instead) but which is plainly not read-only. Covered: `write_file` (`fsWrite`), any `egress`
 * (`http_request` / `web_search` / `mcp_call` / a discovered MCP tool), an `os` action (`read_clipboard` /
 * `notify`), a process tool that resolves a MODEL-CONTROLLED command (a `policyTarget` — `run_command`), and a
 * gate-approval tool. `git_status` has NO `policyTarget` and no gate flag ⇒ read-only, advertised in every
 * mode; `read_file` / `list_directory` are likewise read-only. (The `confirm` floor stays authoritative for
 * the confirmAction classes regardless of what the filter offers.)
 */
export function isGovernedTool(def: ToolDef): boolean {
  if (def.policy.fsWrite === true) return true;
  if (def.policy.egress !== undefined) return true;
  if (def.policy.os === true) return true; // read_clipboard / notify — a governed os action (ADR-0057)
  if (def.policy.requiresGateApproval === true) return true;
  return def.policy.spawnsProcess === true && def.policyTarget !== undefined;
}

/** The set of governed tool ids across a def list — the advertise-filter's `plan` hide set. */
export function governedToolIds(defs: readonly ToolDef[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const def of defs) {
    if (isGovernedTool(def)) out.add(def.id);
  }
  return out;
}

/** What the command rows need of the remembered-grants store: matching always, and writing when the card may offer Remember. */
export interface CommandGrantsPort {
  readonly matches: (argv: readonly string[]) => boolean;
  readonly canRemember?: () => { readonly ok: boolean };
  readonly remember?: (
    argv: readonly string[],
  ) => Promise<{ readonly ok: boolean; readonly reason?: string; readonly id?: string }>;
}

/** The inputs {@link buildTurnPolicy} needs beyond the mode itself — the session-scoped consent machinery. */
export interface TurnPolicyDeps {
  readonly onToolLiveEvent?: ToolLiveObserver;
  /** Governed tool ids (from {@link governedToolIds}) — hidden by the `plan` advertise-filter. */
  readonly governed: ReadonlySet<string>;
  /** The REPL interactive prompt (ask, accept-edits for non-edits and protected paths, and auto's protected-path fallback). */
  readonly prompt: ApprovalPrompt;
  /**
   * Whether a person can answer a card. `false` (a plain / `--json` chat, a one-shot run) means no `Ctrl+Y` can ever
   * come, so the governed tools are hidden from the model exactly as in `plan` rather than offered and then
   * refused: it never sees a tool it cannot use, and no approval request is published that nothing could answer.
   * The confirm floor still refuses if the model names a hidden tool. Absent ⇒ `true`.
   */
  readonly canAsk?: boolean;
  /** The session once/always memory. */
  readonly cache: ApprovalCache;
  /**
   * The remembered command grants for this project root (ADR-0118 §2): a command that matches one is PRE-APPROVED, which is what
   * lets `auto` run it without a card. Absent ⇒ nothing is remembered. A store that cannot answer says `false`.
   */
  readonly commandGrants?: CommandGrantsPort;
  /**
   * Whether the card offers "this exact command for the session" and "remember it" (ADR-0118 §1 "Session", "Remember"). `false` ⇒
   * a command's card offers Once and Deny only. Switched on together with the command card that words them truthfully: a card
   * that did not would read a session answer as "all `run_command` calls", which it must not.
   */
  readonly commandSessionGrants?: boolean;
  /** The directory a command runs in — the host's, shown on the card and the anchor of its protected-path check. */
  readonly commandCwd?: string;
  /** Where a note for the person goes (a Remember that could not be written). Never given a command. */
  readonly notify?: (message: string) => void;
  /**
   * Whether the approval REQUEST targets a protected path, so `auto` falls back to a prompt rather than
   * auto-approving (ADR-0057). Absent ⇒ `auto` auto-approves every governed action (the fs-layer
   * protected-paths refusal is still the hard floor either way).
   *
   * Takes the whole request, not the preview: `request.preview` is a redacted DISPLAY projection (#91) whose
   * scrub can turn a protected path into an unprotected-looking one, so a security classifier must read
   * `request.unredactedPreview` — see {@link ToolApprovalRequest.unredactedPreview}.
   */
  readonly isProtectedTarget?: (request: ToolApprovalRequest) => boolean;
}

/**
 * Map a {@link ChatMode} to the {@link SessionTurnPolicy} the host pushes to `AgentSession.setTurnPolicy`.
 * Setting ANY policy activates the fail-closed approval regime (the dispatch context's `approval` is present),
 * so a governed dispatch always requires a `confirm` decision — the reason a wiring bug can never let `plan`
 * write. `plan` also hides governed tools from the model (best-effort); `ask`/`accept-edits`/`auto` advertise
 * every granted tool and rely on `confirm`.
 */
export function buildTurnPolicy(requested: ChatMode, deps: TurnPolicyDeps): SessionTurnPolicy {
  const canAsk = deps.canAsk !== false;
  // Fail closed HERE, not only in the callers: with no one to answer a card, a mode that approves a governed
  // action without one (accept-edits, auto) is never honoured — it degrades to `ask`, which asks every time and so
  // refuses through the non-interactive prompt. `plan` already refuses everything and stays as it is.
  const mode: ChatMode =
    !canAsk && (requested === 'accept-edits' || requested === 'auto') ? 'ask' : requested;
  const advertise = advertiseFor(mode, deps.governed, canAsk);
  const confirm = confirmFor(mode, deps);
  const live = deps.onToolLiveEvent === undefined ? {} : { onToolLiveEvent: deps.onToolLiveEvent };
  return advertise === undefined ? { confirm, ...live } : { advertise, confirm, ...live };
}

/**
 * The advertise-filter for a mode: `plan` — and any mode with no one to ask — offers only non-governed tools;
 * the others offer all.
 */
function advertiseFor(
  mode: ChatMode,
  governed: ReadonlySet<string>,
  canAsk: boolean,
): ((toolId: string) => boolean) | undefined {
  if (mode === 'plan' || !canAsk) {
    return (toolId) => !governed.has(toolId);
  }
  return undefined; // ask / accept-edits / auto advertise every granted tool — the confirm floor gates them
}

/**
 * Whether an approval preview carries NO concrete target to review — no INFORMATIVE `path` (fs_write),
 * `command` (process), or `host` (egress http).
 *
 * "Informative", not merely "present" (#W15-12): a field reduced entirely to redaction markers and separators
 * shows the user nothing, and treating it as concrete let a blank check be cached. True for `mcp_call` /
 * `web_search` (`previewFor` returns `{}`), whose action class is "enough" to gate but names no specific
 * server/tool/args, AND for a fully-scrubbed target. Such a grant must be once-only (never an `always`-cached
 * blank check). See {@link isInformative} for where the line falls.
 */
function isBlankPreview(preview: ToolActionPreview): boolean {
  // Keyed by `keyof ToolActionPreview` so a NEW reviewable field breaks the build HERE (it must be added below)
  // rather than silently making a preview that carries it look "blank" — which would re-open the `always` blank
  // check this closes. Every field must be absent for the preview to count as blank.
  const fields: Record<keyof ToolActionPreview, string | undefined> = {
    path: preview.path,
    command: preview.command,
    host: preview.host,
  };
  return Object.values(fields).every((value) => !isInformative(value));
}

/**
 * The redaction marker `redactSecretShapedText` substitutes. A preview field reduced ENTIRELY to these carries
 * no information, even though it is present.
 */
const REDACTION_MARKER = /\[redacted\]/gi;

/**
 * Does this preview field actually tell the approver anything?
 *
 * PRESENT is not the same as INFORMATIVE, and #91's fix is what made the difference reachable: `previewFor` now
 * scrubs secret-shaped text, so a path or command can arrive as literally `[redacted]`. Treating that as
 * informative meant a user could be shown `Approve write to [redacted]?`, press "always", and silently
 * authorise EVERY later `write_file` / `run_command` / `http_request` for the session — having seen nothing.
 * A blanket grant must be paid for with real information.
 */
function isInformative(value: string | undefined): boolean {
  if (value === undefined) return false;
  // Strip the markers and any punctuation/whitespace that framed them; what remains is the real content.
  return value.replace(REDACTION_MARKER, '').replace(/[\s/\\.:,;'"`|=-]+/g, '').length > 0;
}

/**
 * Ask the person, remembering an "always" answer only when the preview showed a concrete target. A BLANK
 * preview (mcp_call / web_search — `previewFor` returns no path/command/host) gives the user nothing to review,
 * so "always" there would be an unreviewed, session-long blank check over any future server/tool/args (a
 * prompt-injection-after-one-grant hazard, ADR-0057 review). For those the grant is once-only (cacheable=false
 * ⇒ the REPL greys out `Ctrl+G` and toDecision never caches).
 */
async function askPerson(
  request: ToolApprovalRequest,
  deps: TurnPolicyDeps,
  signal: AbortSignalLike | undefined,
  live: ToolApprovalLiveContext | undefined,
): Promise<ToolApprovalDecision> {
  if (deps.cache.isAlways(request.toolId)) return { outcome: 'approve' };
  const cacheable = live?.preview.kind !== 'saved-result' && !isBlankPreview(request.preview);
  const answer = await deps.prompt(request, cacheable, signal, live);
  return toDecision(answer, request, deps.cache, cacheable);
}

/** The argv of a command request, or `undefined` for any other action class (or a hand-built request without one). */
function commandArgv(request: ToolApprovalRequest): readonly string[] | undefined {
  return request.action === 'process' ? request.argv : undefined;
}

/**
 * A command is PRE-APPROVED when the allowlist admitted it or a remembered grant covers its exact argv (ADR-0118 §1). Only `auto`
 * acts on that: `ask` and `accept-edits` keep asking for an allowlisted or remembered command (an allowlist removes the unknown,
 * not the person's per-call consent). An exact argv approved earlier in THIS session is honoured by {@link askAboutCommand} in every
 * mode, which is what removes the card there.
 */
function isPreApproved(
  request: ToolApprovalRequest,
  argv: readonly string[],
  deps: TurnPolicyDeps,
): boolean {
  return request.commandAdmitted === true || deps.commandGrants?.matches(argv) === true;
}

/** What a person is told when a Remember could not be written; fixed text, never a command, a path or a keychain message. */
const REMEMBER_FAILURES: Readonly<Record<string, string>> = {
  'no-key': 'the OS keychain is not available',
  unreadable: 'the remembered-commands file could not be read',
  unwritable: 'the remembered-commands file could not be written',
  full: 'the remembered-commands file is full',
};

/**
 * Ask the person about a command. The session cache is keyed by the exact argv, never by tool id. The card is given the facts
 * ADR-0118 §1 lists (standing, a code carrier, a protected path, the directory) and the answers it may offer, and the answer
 * is narrowed to what was offered: a prompt that returns an answer the card did not offer gets Once, never more.
 *
 * *Remember* writes the grant at the moment of the answer (it is the person's consent to this exact command, not to its
 * outcome) and then behaves as *Session* too, so the same command does not ask again in this session. A grant that cannot be
 * written approves this call only and says why.
 */
async function askAboutCommand(
  request: ToolApprovalRequest,
  argv: readonly string[],
  deps: TurnPolicyDeps,
  signal: AbortSignalLike | undefined,
  live: ToolApprovalLiveContext | undefined,
): Promise<ToolApprovalDecision> {
  if (deps.cache.isAlwaysCommand(argv)) return { outcome: 'approve' };
  const grants = deps.commandGrants;
  // The same rule `askPerson` has (#W15-12): no remembered answer over a preview reduced to redaction markers or a delivered saved result.
  const shown = live?.preview.kind !== 'saved-result' && !isBlankPreview(request.preview);
  const facts = commandCardFacts({
    argv,
    commandAdmitted: request.commandAdmitted === true,
    remembered: grants?.matches(argv) === true,
    cwd: deps.commandCwd ?? '',
    sessionOffered: deps.commandSessionGrants === true && shown,
    rememberAvailable:
      deps.commandSessionGrants === true &&
      shown &&
      grants?.remember !== undefined &&
      grants.canRemember?.().ok === true,
  });
  const answer = await deps.prompt(request, facts.offers.session, signal, live, facts);
  if (answer.outcome === 'reject') return toDecision(answer, request, deps.cache, false);
  let scope = answer.scope;
  let grantId: string | undefined;
  // A session answer the card did not offer is floored to Once by `toDecision` (it caches only when `offers.session`).
  if (scope === 'remember') {
    if (!facts.offers.remember || grants?.remember === undefined) {
      scope = 'once';
    } else {
      const written = await grants.remember(argv);
      if (written.ok) {
        scope = 'always'; // remembered for the project, and for the rest of this session too
        grantId = written.id;
        deps.notify?.('Remembered for this project. /permissions lists it and takes it back.');
      } else {
        const why = REMEMBER_FAILURES[written.reason ?? ''] ?? 'it could not be written';
        deps.notify?.(`Allowed once, but not remembered: ${why}.`);
        scope = 'once';
      }
    }
  }
  return toDecision(
    { outcome: 'approve', scope },
    request,
    deps.cache,
    facts.offers.session,
    grantId,
  );
}

/**
 * Fall back to an explicit prompt for a protected-path target. Its answer is NOT cacheable: a protected-path
 * prompt must re-ask every time, and — since the session cache is shared across modes — an "always" here must
 * not silently blanket-approve that tool id in a later turn (a cross-mode consent escalation).
 */
async function askAboutProtectedTarget(
  request: ToolApprovalRequest,
  deps: TurnPolicyDeps,
  signal: AbortSignalLike | undefined,
  live: ToolApprovalLiveContext | undefined,
): Promise<ToolApprovalDecision> {
  const cacheable = false;
  const answer = await deps.prompt(request, cacheable, signal, live);
  return toDecision(answer, request, deps.cache, cacheable);
}

/** Ask for a governed action: a command by its exact argv, any other class by its tool id. */
function askForClass(
  request: ToolApprovalRequest,
  deps: TurnPolicyDeps,
  signal: AbortSignalLike | undefined,
  live: ToolApprovalLiveContext | undefined,
): Promise<ToolApprovalDecision> {
  const argv = commandArgv(request);
  return argv === undefined
    ? askPerson(request, deps, signal, live)
    : askAboutCommand(request, argv, deps, signal, live);
}

/** The per-mode approval hook. The registry only invokes it for a GOVERNED dispatch, so every call is gated. */
function confirmFor(mode: ChatMode, deps: TurnPolicyDeps): ConfirmActionHook {
  return async (request, signal, live): Promise<ToolApprovalDecision> => {
    switch (mode) {
      case 'plan':
        // Read-only. The refusal is a FIXED class + label, so it can return to the model without ever
        // depending on the target (ADR-0117); the turn continues and the model explains what it would do.
        return { outcome: 'reject', denialClass: 'mode', reason: PLAN_REFUSAL };
      case 'ask':
        return askForClass(request, deps, signal, live);
      case 'accept-edits': {
        // File edits inside the workspace are applied without a card; every other governed class keeps its
        // prompt, and a protected target or a delivered saved result is never waved through (ADR-0130).
        if (request.action !== 'fs_write') return askForClass(request, deps, signal, live);
        if (deps.isProtectedTarget?.(request) === true) {
          return askAboutProtectedTarget(request, deps, signal, live);
        }
        if (live?.preview.kind === 'saved-result') return askPerson(request, deps, signal, live);
        return { outcome: 'approve' };
      }
      case 'auto': {
        // auto auto-approves — except a protected-path target, which falls back to an explicit prompt (the fs
        // layer also hard-denies protected paths, so this is the graceful UX, not the security floor).
        if (deps.isProtectedTarget?.(request) === true) {
          return askAboutProtectedTarget(request, deps, signal, live);
        }
        // A COMMAND has a hard edge here (ADR-0118 §1): only a pre-approved one runs without a card. A command request that does
        // not carry its argv cannot be judged pre-approved, so it asks like any other unknown (never the blanket approval below).
        if (request.action === 'process') {
          const argv = commandArgv(request);
          if (argv === undefined) return askPerson(request, deps, signal, live);
          return isPreApproved(request, argv, deps)
            ? { outcome: 'approve' }
            : askAboutCommand(request, argv, deps, signal, live);
        }
        return { outcome: 'approve' };
      }
      default: {
        const exhaustive: never = mode;
        return exhaustive;
      }
    }
  };
}

/**
 * Lower a REPL {@link ApprovalAnswer} to the engine's approve/reject. An `always` answer is remembered ONLY
 * when `allowAlwaysCache` is set (accept-edits) — auto's protected-path fallback passes `false` so a narrow
 * protected-context grant can never leak into a later mode's blanket approval via the shared session cache.
 */
function toDecision(
  answer: ApprovalAnswer,
  request: ToolApprovalRequest,
  cache: ApprovalCache,
  allowAlwaysCache: boolean,
  grantId?: string,
): ToolApprovalDecision {
  if (answer.outcome === 'reject') {
    return {
      outcome: 'reject',
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      ...(answer.denialClass === undefined ? {} : { denialClass: answer.denialClass }),
    };
  }
  if (!allowAlwaysCache || answer.scope !== 'always') return { outcome: 'approve' };
  // A command is remembered by its exact argv; it is never remembered by tool id, which would approve every later command. A
  // command request without an argv (a hand-built one) is not remembered at all.
  if (request.action === 'process') {
    const argv = request.argv;
    return argv === undefined
      ? { outcome: 'approve' }
      : {
          outcome: 'approve',
          onDispatchSucceeded: () => cache.rememberAlwaysCommand(argv, grantId),
        };
  }
  return { outcome: 'approve', onDispatchSucceeded: () => cache.rememberAlways(request.toolId) };
}
