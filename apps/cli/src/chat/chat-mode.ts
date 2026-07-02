import type {
  ConfirmActionHook,
  SessionTurnPolicy,
  ToolActionPreview,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolDef,
} from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

/**
 * The CLI chat **mode** model (2.5.E Step 4, [ADR-0057](../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)).
 * A mode is a POLICY LAYER on the one session instance — never a reseat: it maps to a
 * {@link SessionTurnPolicy} the host pushes via `AgentSession.setTurnPolicy`, controlling only (a) the
 * model-advertised tool subset and (b) the per-dispatch approval decision. The engine stays mode-agnostic;
 * this module is the single home of the ask / plan / accept-edits / auto vocabulary and its two mappings.
 *
 * Two-layer safety (ADR-0057): the advertise-filter is BEST-EFFORT (it keeps a governed tool out of the
 * model's reach), while the `confirm` hook is AUTHORITATIVE — the registry calls it for every governed-class
 * dispatch (fs_write / egress / a model-controlled process), so even if the model names a hidden tool the
 * mode policy still decides. `ask`/`plan` deny governed actions; `accept-edits` prompts (`[a]/[r]/[c]`) with a
 * session once/always memory; `auto` auto-approves EXCEPT a protected-path write, which falls back to a prompt
 * (and the fs layer hard-denies protected paths regardless — the floor beneath every mode).
 */

/** The four chat modes, in `Shift+Tab` cycle order (ADR-0057 — `auto` is on the cycle, not hidden). */
export const CHAT_MODES = ['ask', 'plan', 'accept-edits', 'auto'] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/** The default mode: read-only `ask` (secure by default — no governed action without a deliberate mode step). */
export const DEFAULT_CHAT_MODE: ChatMode = 'ask';

/** Short human labels for the footer indicator + `/mode` output. */
export const MODE_LABEL: Record<ChatMode, string> = {
  ask: 'ask',
  plan: 'plan',
  'accept-edits': 'accept edits',
  auto: 'auto',
};

/** One-line descriptions (the `/mode` help + palette). */
export const MODE_DESCRIPTION: Record<ChatMode, string> = {
  ask: 'read-only — writes, commands, and network are declined',
  plan: 'read-only — draft a plan before acting',
  'accept-edits': 'prompt before each write / command / network call',
  auto: 'auto-approve actions (protected paths still prompt; the fs jail still holds)',
};

/** The next mode in the `Shift+Tab` cycle: ask → plan → accept-edits → auto → ask. */
export function nextMode(mode: ChatMode): ChatMode {
  const index = CHAT_MODES.indexOf(mode);
  return CHAT_MODES[(index + 1) % CHAT_MODES.length] ?? DEFAULT_CHAT_MODE;
}

/** Parse a `/mode <name>` argument to a {@link ChatMode}, tolerating the spaced label (`accept edits`). */
export function parseMode(input: string): ChatMode | undefined {
  const normalized = input.trim().toLowerCase().replace(/\s+/gu, '-');
  return (CHAT_MODES as readonly string[]).includes(normalized)
    ? (normalized as ChatMode)
    : undefined;
}

/**
 * The REPL's interactive answer to an approval prompt — RICHER than the engine's approve/reject because it
 * carries the once/always SCOPE (the engine only needs the final approve/reject). `always` is remembered for
 * the tool id for the rest of the session instance; `once` approves just this invocation.
 */
export type ApprovalAnswer =
  | { readonly outcome: 'approve'; readonly scope: 'once' | 'always' }
  | { readonly outcome: 'reject'; readonly reason?: string };

/** The interactive prompt the REPL supplies (accept-edits, and auto's protected-path fallback). */
export type ApprovalPrompt = (
  request: ToolApprovalRequest,
  signal?: AbortSignalLike,
) => Promise<ApprovalAnswer>;

/**
 * The session-scoped, IN-MEMORY once/always cache (ADR-0057 — NOT persisted across resume, so a `chat-resume`
 * re-prompts). `always` = a tool id approved for the remainder of this session instance; `once` caches
 * nothing (it approves a single invocation, then the next identical call re-prompts).
 */
export class ApprovalCache {
  readonly #always = new Set<string>();
  /** Whether this tool id was previously "always"-approved this session. */
  isAlways(toolId: string): boolean {
    return this.#always.has(toolId);
  }
  /** Remember an "always" approval for a tool id (the remainder of this session instance). */
  rememberAlways(toolId: string): void {
    this.#always.add(toolId);
  }
}

/**
 * Whether a tool is a mutating/side-effecting action the `ask`/`plan` advertise-filter HIDES. It is a superset
 * of the registry's runtime `confirmAction` `governedAction`: it also hides a `requiresGateApproval` tool
 * (`git_commit`), which `confirmAction` does NOT gate (its `enforcePolicy` human-gate floor denies it on the
 * chat path instead) but which is plainly not read-only. Covered: `write_file` (`fsWrite`), any `egress`
 * (`http_request` / `web_search` / `mcp_call` / a discovered MCP tool), a process tool that resolves a
 * MODEL-CONTROLLED command (a `policyTarget` — `run_command`), and a gate-approval tool. `git_status` has NO
 * `policyTarget` and no gate flag ⇒ read-only, advertised in every mode; `read_file` / `list_directory` /
 * `read_clipboard` are likewise read-only. (The `confirm` floor stays authoritative for the confirmAction
 * classes regardless of what the filter offers.)
 */
export function isGovernedTool(def: ToolDef): boolean {
  if (def.policy.fsWrite === true) return true;
  if (def.policy.egress !== undefined) return true;
  if (def.policy.requiresGateApproval === true) return true;
  return def.policy.spawnsProcess === true && def.policyTarget !== undefined;
}

/** The set of governed tool ids across a def list — the advertise-filter's `ask`/`plan` hide set. */
export function governedToolIds(defs: readonly ToolDef[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const def of defs) {
    if (isGovernedTool(def)) out.add(def.id);
  }
  return out;
}

/** The inputs {@link buildTurnPolicy} needs beyond the mode itself — the session-scoped consent machinery. */
export interface TurnPolicyDeps {
  /** Governed tool ids (from {@link governedToolIds}) — hidden by the `ask`/`plan` advertise-filter. */
  readonly governed: ReadonlySet<string>;
  /** The REPL interactive prompt (accept-edits, and auto's protected-path fallback). */
  readonly prompt: ApprovalPrompt;
  /** The session once/always memory. */
  readonly cache: ApprovalCache;
  /**
   * Whether an approval preview targets a protected path, so `auto` falls back to a prompt rather than
   * auto-approving (ADR-0057). Absent ⇒ `auto` auto-approves every governed action (the fs-layer
   * protected-paths refusal is still the hard floor either way).
   */
  readonly isProtectedTarget?: (preview: ToolActionPreview) => boolean;
}

/**
 * Map a {@link ChatMode} to the {@link SessionTurnPolicy} the host pushes to `AgentSession.setTurnPolicy`.
 * Setting ANY policy activates the fail-closed approval regime (the dispatch context's `approval` is present),
 * so a governed dispatch always requires a `confirm` decision — the reason a wiring bug can never let `ask`
 * write. `ask`/`plan` also hide governed tools from the model (best-effort); `accept-edits`/`auto` advertise
 * every granted tool and rely on `confirm`.
 */
export function buildTurnPolicy(mode: ChatMode, deps: TurnPolicyDeps): SessionTurnPolicy {
  const advertise = advertiseFor(mode, deps.governed);
  const confirm = confirmFor(mode, deps);
  return advertise === undefined ? { confirm } : { advertise, confirm };
}

/** The advertise-filter for a mode: `ask`/`plan` offer only non-governed tools; the others offer all. */
function advertiseFor(
  mode: ChatMode,
  governed: ReadonlySet<string>,
): ((toolId: string) => boolean) | undefined {
  if (mode === 'ask' || mode === 'plan') {
    return (toolId) => !governed.has(toolId);
  }
  return undefined; // accept-edits / auto advertise every granted tool — the confirm floor gates them
}

/** The per-mode approval hook. The registry only invokes it for a GOVERNED dispatch, so every call is gated. */
function confirmFor(mode: ChatMode, deps: TurnPolicyDeps): ConfirmActionHook {
  return async (request, signal): Promise<ToolApprovalDecision> => {
    switch (mode) {
      case 'ask':
      case 'plan':
        return { outcome: 'reject', reason: `not allowed in ${MODE_LABEL[mode]} mode (read-only)` };
      case 'accept-edits':
        if (deps.cache.isAlways(request.toolId)) return { outcome: 'approve' };
        // An "always" answer here IS remembered (the accept-edits once/always memory).
        return toDecision(await deps.prompt(request, signal), request.toolId, deps.cache, true);
      case 'auto':
        // auto auto-approves — except a protected-path target, which falls back to an explicit prompt (the fs
        // layer also hard-denies protected paths, so this is the graceful UX, not the security floor). Its
        // answer is NOT cacheable: a protected-path prompt must re-ask every time, and — since the session
        // cache is shared across modes — an "always" here must not silently blanket-approve that tool id in a
        // later accept-edits turn (a cross-mode consent escalation). So the auto fallback never remembers.
        if (deps.isProtectedTarget?.(request.preview) === true) {
          return toDecision(await deps.prompt(request, signal), request.toolId, deps.cache, false);
        }
        return { outcome: 'approve' };
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
  toolId: string,
  cache: ApprovalCache,
  allowAlwaysCache: boolean,
): ToolApprovalDecision {
  if (answer.outcome === 'reject') {
    return answer.reason === undefined
      ? { outcome: 'reject' }
      : { outcome: 'reject', reason: answer.reason };
  }
  if (allowAlwaysCache && answer.scope === 'always') cache.rememberAlways(toolId);
  return { outcome: 'approve' };
}
