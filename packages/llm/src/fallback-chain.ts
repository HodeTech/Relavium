import type { AbortSignalLike, BackoffStrategy, ContentPart, MediaSource } from '@relavium/shared';

import type { CostTracker, CostUpdate } from './cost-tracker.js';
import { UnknownModelError } from './errors.js';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  openDeadline,
  type AbortControllerLike,
  type DeadlineScope,
  type SetDeadlineTimer,
} from './attempt-deadline.js';
import { isRetryable, LlmProviderError, makeLlmError } from './llm-error.js';
import { verifyStreamGrammar } from './stream-grammar.js';
import { ProviderIdSchema } from './types.js';
import type {
  LlmError,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  ProviderId,
  StreamChunk,
  Usage,
} from './types.js';
import { requestSupportReason } from './capabilities.js';
import { catalogModel } from './catalog/lookup.js';
import { acceptedTiers } from './reasoning-wire.js';

export type { BackoffStrategy };

/**
 * The `FallbackChain` runner (1.K) — the seam's last Phase-1 policy layer. It walks an ordered plan
 * of provider attempts: within an entry it retries the **same** provider up to that entry's budget on
 * a classified-**retryable** `LlmError` (with backoff), then advances to the next entry; on a **fatal**
 * `LlmError` it stops immediately rather than masking a real bug by falling through. Adapters stay
 * dumb — fallback is **policy outside the adapter** ([ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md),
 * [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md)).
 *
 * Every decision is a pure function of the classified `LlmError` discriminant (`kind`/`retryable`,
 * 1.I) — **never** content/string-sentinel inspection: a body containing `'Error:'` or an empty
 * body does not by itself trigger failover. The runner reuses {@link isRetryable} rather than
 * re-deriving the partition, so the single source of truth holds.
 *
 * Four behavioural nuances the chain honours (per phase-1 §1.K):
 * - **No blind auth retry.** An `auth`-class failure is never re-attempted on the same entry (it
 *   repeats deterministically); at most ONE out-of-band credential refresh
 *   ({@link FallbackChainOptions.onAuthError}) buys exactly one more attempt, never the attempt loop.
 *   Auth is otherwise fatal — it stops the chain.
 * - **Rate-limit cooldown.** A rate-limited entry is parked in a per-provider cooldown so an
 *   immediately-following call on the same chain instance skips the saturated provider rather than
 *   hammering it again.
 * - **No failover after the first content chunk.** Once a stream has emitted any content downstream, a
 *   mid-stream error surfaces to the node-retry layer (1.S) instead of silently re-issuing on the next
 *   provider — re-issuing would duplicate tokens and tool side effects.
 * - **Visible failover.** Each attempt (succeeded / failed / skipped) is reported via
 *   {@link FallbackChainOptions.onAttempt} so the engine (1.O) can emit a `cost:updated` per attempt
 *   and a structured warn log — never a silent provider switch.
 *
 * **ADR-0030 strip-on-failover:** when advancing to a *different* provider, the runner drops every
 * `reasoning` content part (and its ephemeral provider `signature`) from the request before
 * re-issuing — a provider-signed signature is a same-provider, same-turn continuity token and is
 * never replayed across a provider boundary.
 */

/**
 * One resolved entry in the fallback plan: a provider **instance** paired with the canonical model id
 * to send and the attempt budget at that entry. The engine (1.O) builds the ordered plan from the
 * agent's primary `model`/`provider` (+ `retry`) followed by each authored `fallback_chain` entry
 * (`{ model, provider, max_attempts }`); the runner consumes the normalized plan and never imports
 * the agent schema.
 */
export interface FallbackPlanEntry {
  /** The resolved adapter for this entry (its `id` selects the credential and drives cooldown state). */
  readonly provider: LlmProvider;
  /** The canonical model id sent for this entry (each entry may name a different model). */
  readonly model: string;
  /** Attempt budget at this entry — a positive integer (the primary uses `retry.max`, each fallback its `max_attempts`). */
  readonly maxAttempts: number;
  /** Same-model retry backoff curve for this entry; defaults to `'exponential'`. */
  readonly backoff?: BackoffStrategy;
}

/** How one attempt in the visible trace ended. */
export type AttemptOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * One entry in the attempt trace — the visibility payload the engine (1.O) turns into a `cost:updated`
 * per attempt and a warn log; the runner itself emits no events and imports no event bus. `error` is
 * already secret-free (the adapter redacted `message`); as everywhere, a sink must never serialize
 * `LlmError.cause` (the run-event error shape is only `{ code, message, retryable }`).
 */
export interface AttemptRecord {
  /**
   * 1-based **positional** index of this record in the current `generate`/`stream` call's trace —
   * it counts skipped entries too, so it is NOT the run-event spec's per-real-call "retry attempt"
   * number ([sse-event-schema.md](../../../docs/reference/contracts/sse-event-schema.md)). The
   * engine (1.O) derives the `cost:updated.attemptNumber` it emits (e.g. by counting only the
   * non-skipped records), rather than forwarding this field verbatim.
   */
  readonly attemptNumber: number;
  /** The provider this attempt targeted. */
  readonly provider: ProviderId;
  /** The canonical model id this attempt used. */
  readonly model: string;
  /** Whether the attempt succeeded, failed (provider error), or was skipped (capability/cooldown). */
  readonly outcome: AttemptOutcome;
  /** The usage the attempt produced, when it produced any (a successful call). */
  readonly usage?: Usage;
  /** The cost folded into the tracker for this attempt (present iff a `costTracker` is wired and usage existed). */
  readonly cost?: CostUpdate;
  /** The classified failure on `outcome === 'failed'` (secret-free; never serialize `.cause`). */
  readonly error?: LlmError;
  /** Why a `'skipped'` entry was skipped (provider in cooldown, or it can't satisfy the request). */
  readonly skipReason?: string;
  /**
   * `false` when the attempt produced real usage but the model could not be PRICED, so `cost` is absent for a
   * reason other than "there was nothing to charge" (2.6.Q's realized-cost half, ADR-0071 §K7).
   *
   * Without it, "no cost" was ambiguous between *could not price* and *genuinely free* — and a strict cost cap
   * cannot be enforced over a model whose spend is unknown, so the surface must be able to say so instead of
   * silently reporting zero. Absent (rather than `true`) on the ordinary priced path, so nothing changes shape
   * for existing consumers; ADR-0070's durable `unpriced_calls` counter is the same distinction, persisted.
   */
  readonly priced?: false;
}

/**
 * Hook called immediately before a provider attempt is actually dispatched (after skip checks,
 * after the attempt record is allocated, but before credential resolution / the seam call).
 * In 1.AC this is where the pre-egress budget governor runs; a rejected hook aborts the attempt
 * and is surfaced as a fatal chain error.
 */
export type PreAttemptHook = (info: {
  readonly model: string;
  readonly maxTokens?: number;
  /** The provider THIS attempt targets — the routing provider, which on a failover differs from the primary.
   *  The pre-egress endpoint estimate must key on it (not the model's catalog provider): a custom gateway
   *  serving another provider's model id is `custom` at the wire yet `official` by catalog, and the mismatch
   *  under-authorizes real spend (review M2). */
  readonly provider: ProviderId;
}) => void | Promise<void>;

/** Dependencies injected into a {@link FallbackChain} — all timing is injectable so tests are deterministic. */
export interface FallbackChainOptions {
  /**
   * Resolve the credential for a provider at attempt time. Host-aware in value (a resolved key on
   * Node hosts, a keychain reference on the desktop, a managed token in managed mode), `string` in
   * type. The runner threads it through unchanged and never logs, stores, or inspects it.
   */
  readonly keyFor: (provider: ProviderId) => string | Promise<string>;
  /**
   * The per-node/session cost sink. `record(model, usage)` is called once per attempt that produced
   * usage, against **that attempt's** canonical model id, so cost stays accurate across a failover.
   *
   * Declared as the RECORD CONTRACT rather than the concrete `CostTracker` class, because that is all the
   * chain consumes. A real tracker satisfies it unchanged; what it removes is the reason every test double
   * needed an `as unknown as CostTracker` to stand in for a class it was never pretending to be.
   */
  readonly costTracker?: Pick<CostTracker, 'record'>;
  /** Visibility hook fired once per attempt (succeeded / failed / skipped). */
  readonly onAttempt?: (record: AttemptRecord) => void;
  /**
   * Pre-egress hook called before every real provider attempt (not called for skipped entries).
   * See {@link PreAttemptHook}.
   */
  readonly preAttempt?: PreAttemptHook;
  /**
   * The delay primitive used for backoff between same-entry retries. **Required and host-injected**:
   * the seam is platform-free (no ambient `setTimeout`), so the host supplies the timer — a
   * `setTimeout`-based delay on every real surface, a controllable fake in tests.
   *
   * The optional `signal` must settle the delay EARLY when it aborts, and clear the underlying timer
   * (#W15-14). A provider's `Retry-After` is honoured up to a 60 s ceiling, and without this a cancel
   * during that window did nothing: the turn kept sitting in a timer no one was waiting for any more.
   * Optional so a 1-argument implementation stays assignable — but every real host takes it.
   */
  readonly sleep: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  /** Injectable clock for cooldown bookkeeping (default: `Date.now`, an ECMAScript primitive). */
  readonly now?: () => number;
  /**
   * The per-attempt deadline's two host-injected primitives
   * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
   * §6). `sleep`/`now` above are not a disarmable one-shot timer and a merged abort needs a controller, so
   * the port is its own pair — platform-free, exactly like the others.
   *
   * **Both or neither.** Supplying only one leaves the deadline unarmed, and an unbounded wait is the state
   * this removes — so a chain built without them keeps the old behaviour and says so at construction rather
   * than half-applying the guarantee.
   */
  readonly newAbortController?: () => AbortControllerLike;
  readonly setTimer?: SetDeadlineTimer;
  /** Per-attempt deadline in ms (default {@link DEFAULT_ATTEMPT_TIMEOUT_MS}). Must be finite and positive. */
  readonly attemptTimeoutMs?: number;
  /** Base backoff delay in ms before the first retry of an entry (default 250). */
  readonly backoffBaseMs?: number;
  /** Backoff delay ceiling in ms (default 8000). */
  readonly backoffMaxMs?: number;
  /** How long a rate-limited provider is parked before a later call retries it (default 30000 ms). */
  readonly cooldownMs?: number;
  /**
   * Optional single out-of-band credential refresh on an `auth` failure. Called at most once per
   * provider per chain instance; returning `true` grants exactly one more attempt at that entry,
   * `false`/absent makes the auth failure fatal. Never becomes a retry loop.
   */
  readonly onAuthError?: (provider: ProviderId) => boolean | Promise<boolean>;
  /**
   * Resolve a durable media `handle` to the in-flight {@link MediaSource} a specific provider's egress
   * needs (1.AF/D8, [ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md)).
   * Host-injected (backed by `MediaStore.resolveForEgress`) so the **chain stays byte-free + platform-free**
   * — it calls a function, never holds a `MediaStore`. Before each attempted entry the chain re-materializes
   * every `handle` source in the request for that entry's provider (so the adapter only ever sees an
   * already-resolved source); a non-base64 provider ref is cached per `(provider, handle)` and re-materialized
   * on a cross-provider advance, a base64 source is never cached (the sidecar stays byte-free). Absent ⇒ a
   * `handle` source is sent to the adapter unchanged (no-op).
   */
  readonly resolveForEgress?: (handle: string, provider: ProviderId) => Promise<MediaSource>;
}

const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 8_000;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * What a classified failure means for the chain.
 *
 * No longer a pure function of `LlmError.kind`: `'advance'` exists because *retry this entry* and *try a
 * different provider* stopped being one decision (ADR-0082 §9). A `protocol` violation must not be
 * re-attempted against the same implementation — it will break the grammar again — but before any content
 * has been shown there is nothing to lose by trying the next entry, and `'retryable'` would first burn this
 * entry's whole attempt budget on a provider we already know is broken.
 */
type Verdict = 'fatal' | 'retryable' | 'auth-refreshed' | 'advance';

/**
 * Strip every `reasoning` content part from a request's messages — a pure transform producing a new
 * request (the input is never mutated). Dropping the whole part removes its ephemeral `signature`
 * along with `text`/`redacted`; a message left with no content is dropped. Runs on a cross-provider
 * advance so a provider-signed reasoning block never crosses a provider boundary (ADR-0030).
 */
/**
 * Drop every `tool_call` continuation token from a request, keeping the calls themselves (ADR-0090).
 *
 * Separate from {@link stripReasoningParts} because the two answer different questions. A reasoning part is
 * DROPPED WHOLE on a provider boundary — its text is the provider's, and the next one has no use for it. A
 * `tool_call` must SURVIVE: the call and its result are the conversation the next model still needs, and
 * only the opaque token is meaningless (or, on Gemini, rejected) to it. Non-mutating, like its sibling; a
 * message never empties, so no adjacent-role merge is needed.
 */
export function stripToolCallSignatures(req: LlmRequest): LlmRequest {
  return {
    ...req,
    messages: req.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool_call' && part.signature !== undefined
          ? stripToolCallSignature(part)
          : part,
      ),
    })),
  };
}

/**
 * Drop a `tool_call`'s ephemeral continuation token, keeping every other field (ADR-0090).
 *
 * Rebuilt field-by-field rather than destructured-and-spread: with `exactOptionalPropertyTypes` an explicit
 * `undefined` is not the same as an ABSENT key, and both the durable parse and the Gemini replay test for
 * absence — so the token has to be genuinely gone, not merely undefined.
 */
function stripToolCallSignature(part: Extract<ContentPart, { type: 'tool_call' }>): ContentPart {
  return {
    type: 'tool_call',
    id: part.id,
    name: part.name,
    args: part.args,
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
  };
}

export function stripReasoningParts(req: LlmRequest): LlmRequest {
  const kept = req.messages
    .map((message) => ({
      ...message,
      content: message.content.filter((part) => part.type !== 'reasoning'),
    }))
    .filter((message) => message.content.length > 0);
  // Dropping a reasoning-only message can leave two adjacent same-role messages, which strict
  // providers (e.g. Anthropic) reject as a non-alternating sequence — so a failover meant to RESCUE
  // the turn would instead 400. Merge adjacent same-role messages to keep the request well-formed.
  // (A provider that additionally collapses distinct seam roles — Anthropic maps `tool`→user — owns
  // that provider-specific normalization in its adapter; this only guarantees the seam-level shape.)
  const messages: LlmMessage[] = [];
  for (const message of kept) {
    const previous = messages.at(-1);
    if (previous !== undefined && previous.role === message.role) {
      messages[messages.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
      };
    } else {
      messages.push(message);
    }
  }
  return { ...req, messages };
}

/**
 * Point a request at a chain entry's model AND strip a reasoning-effort tier the entry model does NOT support
 * ([ADR-0066](../../../docs/decisions/0066-normalized-reasoning-effort-control.md) §4). A failover to a
 * non-reasoning model must not carry the primary's tier: the provider would reject the unsupported parameter, and a
 * `400` on an unsupported param is fatal + non-retryable — so the whole remaining chain would abort rather than the
 * failover rescuing the turn. The per-model capability is the SAME {@link acceptedTiers} the host projects
 * to the engine gate, so the primary is gated at the engine and each fallback entry is re-gated here. Exported for
 * a focused unit test (like {@link stripReasoningParts}).
 */
export function withEntryModel(req: LlmRequest, model: string): LlmRequest {
  const next: LlmRequest = { ...req, model };
  if (next.reasoningEffort === undefined) return next;

  // ADR-0071 §6: re-gate on the tiers the ENTRY MODEL ACCEPTS — not on whether it reasons.
  //
  // This used to ask `modelSupportsReasoning(model)`, a boolean, and that is how the primary bug reached the wire
  // through a failover: `claude-opus-4-8` accepts `max`, `claude-opus-4-5` does NOT (it publishes
  // ['low','medium','high']). Both "support reasoning", so the boolean kept the tier — and the fallback, whose
  // whole job is to RESCUE a failing turn, sent a value the rescue model rejects. A 400 on an unsupported param is
  // fatal and non-retryable, so the chain aborts instead: the failover kills the turn it exists to save.
  const entry = catalogModel(model);
  const accepted = acceptedTiers(entry?.provider ?? 'openai', entry?.reasoning);
  if (accepted.has(next.reasoningEffort)) return next;

  // The entry model rejects this tier — return it stripped. A fresh object (not a mutate-then-return of `next`)
  // so the two exit paths are demonstrably distinct values.
  const stripped: LlmRequest = { ...next };
  delete stripped.reasoningEffort;
  return stripped;
}

/** The backoff delay before the `retryIndex`-th retry of an entry (0 = before the 2nd attempt). */
function backoffDelayMs(
  strategy: BackoffStrategy,
  retryIndex: number,
  baseMs: number,
  maxMs: number,
): number {
  const raw = strategy === 'exponential' ? baseMs * 2 ** retryIndex : baseMs * (retryIndex + 1);
  return Math.min(raw, maxMs);
}

/**
 * Strip `contentCommitted` from an error the CHAIN did not set it on.
 *
 * The field rides `LlmErrorSchema`, which is the type PROVIDERS construct and put in an `error` chunk — so
 * a provider could set it on a PRE-content failure and, through the fold above the chain, delete the node's
 * entire retry budget. A review measured it: adding the flag to a pre-content timeout dropped provider calls
 * from three to one. Fail-closed, so no money hazard — it silently removes transient-failure recovery.
 *
 * This is the trust-boundary class ADR-0082 §3 is written about: a rule enforced only inside implementations
 * we happen to own is a coincidence. Stripping on ingress makes {@link committed} the field's only writer,
 * which turns a convention into an invariant.
 */
function disown(error: LlmError): LlmError {
  if (error.contentCommitted === undefined) return error;
  const rest = { ...error };
  delete rest.contentCommitted;
  return rest;
}

/**
 * Mark a surfaced failure as having happened PAST the first content chunk
 * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §4).
 *
 * A separate field rather than an override of `retryable`, so `makeLlmError`'s invariant — retryability is a
 * pure function of `kind` — survives. A reader seeing `kind: 'timeout', retryable: false` could not tell a
 * deliberate suppression from a bug; `contentCommitted: true` says which and why.
 */
function committed(error: LlmError): LlmError {
  return { ...error, contentCommitted: true };
}

/**
 * The same request under a different signal — the merged caller-or-deadline one.
 *
 * A copy, never a mutation: `entryReq` is reused across retries of the same entry, and rewriting its signal
 * in place would leave a disposed scope's signal attached to the next attempt.
 */
function withSignal(req: LlmRequest, signal: AbortSignalLike): LlmRequest {
  return { ...req, signal };
}

/** A content chunk commits a stream — anything other than the terminal `stop`/`error` arms. */
function isContentChunk(chunk: StreamChunk): boolean {
  return chunk.type !== 'stop' && chunk.type !== 'error';
}

/** True when any message carries a durable `handle` media source needing egress re-materialization (D8). */
function hasHandleMedia(req: LlmRequest): boolean {
  return req.messages.some((message) =>
    message.content.some((part) => part.type === 'media' && part.source.kind === 'handle'),
  );
}

/** What one `generate` attempt produced. */
type GenerateAttempt =
  | { readonly status: 'success'; readonly result: LlmResult }
  | { readonly status: 'error'; readonly error: LlmError };

export class FallbackChain {
  readonly #plan: readonly FallbackPlanEntry[];
  readonly #options: FallbackChainOptions;
  readonly #sleep: (ms: number, signal?: AbortSignalLike) => Promise<void>;
  readonly #attemptTimeoutMs: number;
  readonly #newAbortController: (() => AbortControllerLike) | undefined;
  readonly #setTimer: SetDeadlineTimer | undefined;
  readonly #now: () => number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #cooldownMs: number;
  /** Per-provider cooldown expiry (ms), persisted across calls on this instance (rate-limit nuance). */
  readonly #cooldownUntil = new Map<ProviderId, number>();
  // The media egress re-materialization sidecar (ADR-0043 §4, D7): a per-`(provider, handle)` cache of
  // NON-base64 resolved sources (a provider-hosted ref). It is byte-free (a base64 source is never cached),
  // never persisted/logged/checkpointed, and survives across generate/stream calls on this instance so a
  // multi-call tool loop reuses a provider ref instead of re-uploading; a cross-provider advance misses
  // the cache (a different key) and re-materializes, so a foreign provider's ref never crosses a boundary.
  readonly #egressSidecar = new Map<string, MediaSource>();
  // The cross-CALL reasoning strip latch (ADR-0039). Unlike the per-call `ChainRun.#lastProvider`,
  // this survives across generate/stream calls so a multi-turn tool loop on ONE chain instance strips
  // a prior provider's signed reasoning before it can reach a different provider's next call. A chain
  // instance is **single-flight by contract** — one node execution's *sequential* tool loop; concurrent
  // generate/stream on the same instance would race this latch, so concurrent agent vertices each get
  // their own chain (the AgentRunner builds one per node execution — ADR-0038).
  #lastProviderAcrossCalls: string | undefined;
  /** Providers whose one-shot auth refresh has already been spent on this instance. */
  readonly #authRefreshed = new Set<ProviderId>();
  /** A provider id to attribute an all-skipped synthetic error to (the last plan entry's). */
  readonly #exhaustedProvider: ProviderId;

  constructor(plan: readonly FallbackPlanEntry[], options: FallbackChainOptions) {
    const lastEntry = plan.at(-1);
    if (lastEntry === undefined) {
      // A wiring invariant, not a provider failure: the engine always supplies at least the primary.
      throw new Error('FallbackChain requires at least one plan entry');
    }
    for (const planEntry of plan) {
      // The engine derives each budget from a schema-validated `retry.max` / `max_attempts`; guard
      // here too so a miswired plan fails loudly rather than silently skipping an entry with no
      // emitted attempt (which would violate the "visible, never a silent provider switch" rule).
      if (!Number.isInteger(planEntry.maxAttempts) || planEntry.maxAttempts < 1) {
        throw new Error('FallbackChain plan entry requires a positive integer maxAttempts');
      }
    }
    this.#exhaustedProvider = lastEntry.provider.id;
    this.#plan = plan;
    this.#options = options;
    this.#sleep = options.sleep;
    this.#now = options.now ?? Date.now;
    this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.#backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    // **Both or neither** (ADR-0082 §6). Half a deadline is not a smaller guarantee, it is none — so a
    // chain given only one primitive keeps the old unbounded behaviour rather than pretending.
    const timeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      // A configuration error, refused at construction. There is no "disabled" value: unbounded is the
      // state this removes, and a flag restoring it would restore the defect.
      throw new Error(
        `attemptTimeoutMs must be a finite positive number of milliseconds (got ${String(timeoutMs)})`,
      );
    }
    this.#attemptTimeoutMs = timeoutMs;
    this.#newAbortController = options.newAbortController;
    this.#setTimer = options.setTimer;
  }

  /**
   * Run the chain for a non-streaming request. Returns the first entry's `LlmResult`; throws an
   * `LlmProviderError` carrying the classified `LlmError` once the chain is exhausted or a fatal
   * error stops it. Each attempt is reported via `onAttempt`; per-attempt usage is recorded against
   * that attempt's model so cost stays accurate across a failover.
   */
  async generate(req: LlmRequest): Promise<LlmResult> {
    const run = new ChainRun(req, this.#lastProviderAcrossCalls);
    // Why every skip's reason is kept: when the whole plan is skipped there is no provider error to report,
    // and the synthesized one is the only thing the user sees (`CR-51` — see `#exhaustedError`).
    const skipped: string[] = [];
    try {
      for (const entry of this.#plan) {
        this.#throwIfAborted(req, entry.provider.id);
        const skip = this.#skipReason(entry, run.previewRequest(entry));
        if (skip !== undefined) {
          skipped.push(skip);
          this.#emit(run.next(entry, { outcome: 'skipped', skipReason: skip }));
          continue;
        }
        const entryReq = run.beginEntry(entry); // strips on a provider boundary — only for attempted entries
        const materialized = await this.#materializeForEntry(entry, entryReq, run);
        if (materialized === undefined) {
          continue; // a failed media re-materialization advances to the next provider (retryable-advance)
        }
        const result = await this.#runEntryGenerate(entry, materialized, req, run);
        if (result !== undefined) {
          return result;
        }
      }
      throw new LlmProviderError(run.lastError ?? this.#exhaustedError(skipped));
    } finally {
      this.#lastProviderAcrossCalls = run.lastIssuer; // fold the call's latch back for the next call
    }
  }

  /**
   * Run one entry's attempt budget (+ any auth bonus) on the non-streaming path. Returns the result
   * on success, or `undefined` to advance to the next entry; throws `LlmProviderError` on a fatal
   * classification (which stops the whole chain).
   */
  async #runEntryGenerate(
    entry: FallbackPlanEntry,
    entryReq: LlmRequest,
    req: LlmRequest,
    run: ChainRun,
  ): Promise<LlmResult | undefined> {
    const budget = entry.maxAttempts;
    let bonus = 0; // one extra attempt granted by a successful auth refresh (never the retry loop)
    for (let attempt = 1; attempt <= budget + bonus; attempt += 1) {
      this.#throwIfAborted(req, entry.provider.id);
      const outcome = await this.#runGenerateAttempt(entry, entryReq, run);
      if (outcome.status === 'success') {
        return outcome.result;
      }
      run.lastError = outcome.error;
      const verdict = await this.#afterFailure(entry, outcome.error);
      if (verdict === 'fatal') {
        throw new LlmProviderError(outcome.error);
      }
      if (verdict === 'advance') {
        return undefined; // this entry is unusable — do not spend its remaining attempts on it
      }
      if (verdict === 'auth-refreshed') {
        bonus += 1; // +1 attempt ON TOP of the configured budget; retry now (a fresh credential)
        continue;
      }
      if (attempt < budget + bonus) {
        await this.#backoff(entry, attempt - 1, req, outcome.error);
      }
    }
    return undefined; // budget exhausted → advance to the next entry
  }

  /**
   * Run the chain for a streaming request. Yields the surviving provider's chunks. Failover is only
   * attempted **before** the first content chunk is forwarded; once content has been emitted, a
   * later error chunk is surfaced to the consumer (1.S node-retry) rather than re-issued. Like the
   * seam's `stream`, a terminal failure is surfaced as an `error` chunk, not a throw.
   */
  async *stream(req: LlmRequest): AsyncIterable<StreamChunk> {
    const run = new ChainRun(req, this.#lastProviderAcrossCalls);
    // See the `generate` twin: a wholly-skipped plan has no provider error, so the reasons ARE the report.
    const skipped: string[] = [];
    try {
      for (const entry of this.#plan) {
        if (this.#aborted(req)) {
          yield { type: 'error', error: this.#cancelledError(entry.provider.id) };
          return;
        }
        const skip = this.#skipReason(entry, run.previewRequest(entry), { streaming: true });
        if (skip !== undefined) {
          skipped.push(skip);
          this.#emit(run.next(entry, { outcome: 'skipped', skipReason: skip }));
          continue;
        }
        const entryReq = run.beginEntry(entry); // strips on a provider boundary — only for attempted entries
        const materialized = await this.#materializeForEntry(entry, entryReq, run);
        if (materialized === undefined) {
          continue; // a failed media re-materialization advances to the next provider (retryable-advance)
        }
        const action = yield* this.#runEntryStream(entry, materialized, req, run);
        if (action === 'done') {
          return;
        }
      }
      yield { type: 'error', error: run.lastError ?? this.#exhaustedError(skipped) };
    } finally {
      this.#lastProviderAcrossCalls = run.lastIssuer; // fold the call's latch back for the next call
    }
  }

  /**
   * Run one entry's attempt budget (+ any auth bonus) on the streaming path. Yields the surviving
   * provider's chunks; returns `'done'` when the stream is complete (a success, a committed/surfaced
   * failure, a fatal pre-content stop, or a cancellation) or `'advance'` to try the next entry.
   */
  async *#runEntryStream(
    entry: FallbackPlanEntry,
    entryReq: LlmRequest,
    req: LlmRequest,
    run: ChainRun,
  ): AsyncGenerator<StreamChunk, 'done' | 'advance'> {
    const budget = entry.maxAttempts;
    let bonus = 0; // one extra attempt granted by a successful auth refresh (never the retry loop)
    for (let attempt = 1; attempt <= budget + bonus; attempt += 1) {
      if (this.#aborted(req)) {
        yield { type: 'error', error: this.#cancelledError(entry.provider.id) };
        return 'done';
      }
      const record = run.next(entry);
      const attemptState: StreamAttemptState = { committed: false };
      const failure = yield* this.#runStreamAttempt(entry, entryReq, record, attemptState);
      if (attemptState.committed) {
        return 'done'; // content forwarded — any later failure was surfaced inside the attempt
      }
      if (failure === undefined) {
        return 'done'; // a clean, content-free completion (e.g. a bare `stop`) — success emitted
      }
      run.lastError = failure;
      const verdict = await this.#afterFailure(entry, failure);
      if (verdict === 'fatal') {
        yield { type: 'error', error: failure };
        return 'done';
      }
      if (verdict === 'advance') {
        // `run.lastError` is already set above, so an exhausted chain surfaces the real `protocol` cause.
        return 'advance'; // …without spending this entry's remaining attempts on a provider we know is broken
      }
      if (verdict === 'auth-refreshed') {
        bonus += 1; // +1 attempt ON TOP of the configured budget; retry now (a fresh credential)
        continue;
      }
      if (attempt < budget + bonus) {
        await this.#backoff(entry, attempt - 1, req, failure);
      }
    }
    return 'advance'; // budget exhausted → try the next entry
  }

  /** Execute one `generate` attempt and report it; returns the success/error outcome. */
  async #runGenerateAttempt(
    entry: FallbackPlanEntry,
    entryReq: LlmRequest,
    run: ChainRun,
  ): Promise<GenerateAttempt> {
    const record = run.next(entry);
    // The deadline covers THIS arm too, and a review caught it not doing so. ADR-0082's §5 opens with
    // `generate(): Promise<LlmResult> { return new Promise(() => {}) }` as its motivating hang, and §12.10
    // makes it the first acceptance criterion — yet the wiring landed on `stream()` only. The gap was live:
    // `agent-turn.ts` routes an inline media-out turn (ADR-0046) through `chain.generate()`, so a hung
    // provider on that path waited forever on every surface.
    let deadline: DeadlineScope | undefined;
    try {
      const maxTokens = entryReq.maxTokens;
      await this.#options.preAttempt?.({
        model: entry.model,
        provider: entry.provider.id,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      });
      const key = await this.#resolveKey(entry.provider.id);
      // **Re-check the caller AFTER credential resolution, BEFORE the seam call.** `#resolveKey` is I/O — a
      // keychain read, and in Phase 2 a network one — so a cancel landing inside it used to be invisible
      // here: the provider was invoked, the deadline opened afterwards latched an already-aborted caller,
      // and `race()` reported `cancelled` for a request that had nonetheless gone out. A cancelled run must
      // not produce provider traffic, let alone a charge.
      if (this.#aborted(entryReq)) {
        const error = this.#cancelledError(entry.provider.id);
        this.#emit({ ...record, outcome: 'failed', error });
        return { status: 'error', error };
      }
      deadline = this.#openDeadline(entryReq);
      const call = entry.provider.generate(
        deadline === undefined ? entryReq : withSignal(entryReq, deadline.signal),
        key,
      );
      // A `generate()` has no chunks, so there is nothing to commit: a deadline here is always pre-content
      // and may fail over, which is rule 7's other half rather than an exception to it.
      const raced = deadline === undefined ? undefined : await deadline.race(call);
      if (raced?.outcome === 'deadline') {
        const error = this.#classifyDeadline(deadline, entry.provider.id);
        this.#emit({ ...record, outcome: 'failed', error });
        return { status: 'error', error };
      }
      const result = raced === undefined ? await call : raced.value;
      this.#emitSuccess(record, entry.model, result.usage);
      return { status: 'success', result };
    } catch (err) {
      const error = this.#abortAware(
        this.#errorOf(err, entry.provider.id),
        entryReq,
        entry.provider.id,
      );
      this.#emit({ ...record, outcome: 'failed', error });
      return { status: 'error', error };
    } finally {
      deadline?.dispose();
    }
  }

  /**
   * Execute one `stream` attempt: forward every chunk, flip `state.committed` on the first content
   * chunk, and surface a post-content failure inline (no failover). Returns the pre-content failure
   * to fail over on, or `undefined` if the stream completed (a success was already emitted, or a
   * post-content failure was surfaced).
   */
  /**
   * How a failed stream attempt LEAVES — the one decision the three failure sites share.
   *
   * Committed means content already reached the caller, so the failure is SURFACED as an `error` chunk and
   * the chain reports no failover candidate. The `committed()` stamp goes on here, on the way out, because
   * this is the moment the fact becomes the node layer's problem
   * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §4):
   * the chain already refuses to fail over, and without the stamp that refusal stopped at the chain and
   * `#shouldRetry` re-dispatched a call that had already produced output.
   *
   * Uncommitted, the error is RETURNED instead, and the caller decides whether to fail over.
   *
   * Spliced with `yield*`, so the caller's `return yield* …` both forwards the chunk and adopts the return
   * value — the three sites were byte-identical, which is how the `committed()` stamp came to be missing
   * from one of them once already.
   */
  // A SYNC generator: nothing here awaits, and an async one would only add a microtask hop between the
  // emit and the surfaced chunk. An async generator delegates to it with `yield*` unchanged.
  *#failAttempt(
    record: AttemptRecord,
    error: LlmError,
    state: StreamAttemptState,
  ): Generator<StreamChunk, LlmError | undefined> {
    this.#emit({ ...record, outcome: 'failed', error });
    if (state.committed) {
      yield { type: 'error', error: committed(error) };
      return undefined;
    }
    return error;
  }

  async *#runStreamAttempt(
    entry: FallbackPlanEntry,
    entryReq: LlmRequest,
    record: AttemptRecord,
    state: StreamAttemptState,
  ): AsyncGenerator<StreamChunk, LlmError | undefined> {
    let usage: Usage | undefined;
    // Declared outside the `try` so the `finally` can dispose it on EVERY exit path — including success,
    // which is the one most likely to forget. A leaked timer holds the process awake, which on a CLI is a
    // hang the user cannot explain.
    let deadline: DeadlineScope | undefined;
    // Declared beside `deadline`, and for the same reason: the `finally` has to be able to close it on
    // EVERY exit, and a `let` inside the `try` would not be in scope there.
    let iterator: AsyncIterator<StreamChunk> | undefined;
    try {
      const maxTokens = entryReq.maxTokens;
      await this.#options.preAttempt?.({
        model: entry.model,
        provider: entry.provider.id,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      });
      const key = await this.#resolveKey(entry.provider.id);
      // **Re-check the caller AFTER credential resolution, BEFORE the seam call.** `#resolveKey` is I/O — a
      // keychain read, and in Phase 2 a network one — so a cancel landing inside it used to be invisible
      // here: the provider was invoked, the deadline opened afterwards latched an already-aborted caller,
      // and `race()` reported `cancelled` for a request that had nonetheless gone out. A cancelled run must
      // not produce provider traffic, let alone a charge.
      if (this.#aborted(entryReq)) {
        return yield* this.#failAttempt(record, this.#cancelledError(entry.provider.id), state);
      }
      // **The grammar is verified HERE, where the seam is crossed** (ADR-0082 §3). The audited adapters
      // already detect a truncated stream and keep doing so — better-attributed, since an adapter knows it
      // was reading SSE — but the chain accepts ANY `LLMProvider`: a cassette, a test double, and in Phase 2
      // a managed gateway. A rule enforced only inside implementations we happen to own is a coincidence.
      deadline = this.#openDeadline(entryReq);
      const verified = verifyStreamGrammar(
        entry.provider.stream(
          deadline === undefined ? entryReq : withSignal(entryReq, deadline.signal),
          key,
        ),
        entry.provider.id,
      );
      // Manual iteration, not `for await`: every `next()` is raced against the ABSOLUTE deadline. A
      // `for await` can only be bounded by a signal, and a signal is a request the provider may ignore.
      iterator = verified[Symbol.asyncIterator]();
      for (;;) {
        const step = await this.#raceStep(iterator, deadline);
        if (step.kind === 'timeout') {
          return yield* this.#failAttempt(
            record,
            this.#classifyDeadline(deadline, entry.provider.id),
            state,
          );
        }
        if (step.kind === 'done') break;
        const chunk = step.chunk;
        if (chunk.type === 'error') {
          return yield* this.#failAttempt(
            record,
            this.#abortAware(chunk.error, entryReq, entry.provider.id),
            state,
          );
        }
        if (chunk.type === 'stop') {
          usage = chunk.usage;
        }
        state.committed = state.committed || isContentChunk(chunk);
        yield chunk;
      }
    } catch (err) {
      return yield* this.#failAttempt(
        record,
        this.#abortAware(this.#errorOf(err, entry.provider.id), entryReq, entry.provider.id),
        state,
      );
    } finally {
      // Every exit path — success, pre-content failure, surfaced failure, an early consumer `break` that
      // calls this generator's `return()`. Idempotent, so the success path below can be reached having
      // already disposed nothing.
      deadline?.dispose();
      // **And close the source.** Converting `for await` to manual iteration removed the language's own
      // teardown: `for await` calls `return()` on ANY abrupt completion of the body, while the hand-rolled
      // loop only did so on the deadline branch. A review measured two live leaks — a grammar VIOLATION
      // (where the verifier is suspended mid-`yield`, so its own `for await` over the source is still open)
      // and an early consumer `break` — each leaving the provider's body reader uncancelled, the socket
      // held, and tokens still arriving on a call we are still billed for.
      //
      // In the `finally` rather than per branch so a future exit cannot miss it, and best-effort without an
      // unbounded await for the same reason `#raceStep`'s teardown is: caller liveness, not resource
      // termination (ADR-0082 §5). `return()` on an already-completed iterator is a no-op.
      void Promise.resolve(iterator?.return?.(undefined)).catch(() => undefined);
    }
    return yield* this.#settleUsage(entry, record, usage, state);
  }

  /**
   * The attempt SUCCEEDED — now account for what it cost, and surface a fold failure rather than throw it.
   *
   * Sits outside the attempt's `try`/`finally` deliberately, but needs its own guard (#W15-9). `#foldUsage`
   * re-throws anything that is not `UnknownModelError` so a money bug is loud: a provider returning
   * non-integer usage trips `assertAccountableUsage`, and a broken overlay or a custom tracker throws. On the
   * `generate()` path that work sits INSIDE the attempt's try, so the throw reaches the caller classified.
   * Here it escaped the async generator raw — breaking `#runStreamAttempt`'s own contract ("a terminal
   * failure is surfaced as an `error` chunk, not a throw") and taking down a turn whose content had already
   * been produced and billed for.
   *
   * Only the FOLD is guarded. A throw from the attempt OBSERVER is the consumer's bug and keeps propagating
   * on both paths exactly as before — narrowing here means this guard cannot quietly become the handler for
   * someone else's defect.
   */
  *#settleUsage(
    entry: FallbackPlanEntry,
    record: AttemptRecord,
    usage: Usage | undefined,
    state: StreamAttemptState,
  ): Generator<StreamChunk, undefined> {
    if (usage === undefined) {
      this.#emitSuccess(record, entry.model, undefined); // nothing to fold
      return undefined;
    }
    let folded: FoldedUsage;
    try {
      folded = this.#foldUsage(entry.model, usage);
    } catch (err) {
      // A FIXED message, with the original only as `cause`. The raw text is arbitrary — a custom tracker's
      // throw — and this message is serialized into `session:turn_completed.error` / `node:failed.error`,
      // where `cause` never goes. `kind: 'unknown'` derives `retryable: false`, so the node-retry layer does
      // not re-run a call the provider already billed for.
      const error = makeLlmError({
        provider: entry.provider.id,
        kind: 'unknown',
        message: 'cost accounting failed after a successful streamed attempt',
        cause: err,
      });
      // The fold runs BEFORE the emit, so no success record was written — this `failed` record is the
      // attempt's only one, not a duplicate.
      this.#emit({ ...record, outcome: 'failed', error });
      // SURFACED, not returned. `#runEntryStream` checks `state.committed` before it looks at the returned
      // failure, so on the committed path a returned error is dropped on the floor — silence, in the one
      // place the money path was made loud on purpose.
      //
      // Stamped like the other two surfaced failures. `kind: 'unknown'` already derives `retryable: false`,
      // so nothing changes today — but leaving this one bare made "every error the chain surfaces past
      // content carries `contentCommitted`" untrue, and rested this point's no-retry guarantee on a second,
      // unrelated mechanism that a future kind change would quietly break.
      yield { type: 'error', error: state.committed ? committed(error) : error };
      return undefined;
    }
    this.#emitFolded(record, usage, folded);
    return undefined;
  }

  /**
   * Decide what a classified failure means for the chain and apply its side effects. Pure function of
   * `error.kind`/`retryable` (1.I) — never the message. Handles the auth nuance (no blind retry; one
   * optional refresh) and the rate-limit cooldown.
   */
  async #afterFailure(entry: FallbackPlanEntry, error: LlmError): Promise<Verdict> {
    if (error.kind === 'auth') {
      // Never a blind retry loop — at most ONE out-of-band credential refresh, then fatal.
      const hook = this.#options.onAuthError;
      if (hook !== undefined && !this.#authRefreshed.has(entry.provider.id)) {
        this.#authRefreshed.add(entry.provider.id);
        if (await this.#refreshCredential(hook, entry.provider.id)) {
          return 'auth-refreshed';
        }
      }
      return 'fatal';
    }
    if (error.kind === 'rate_limit') {
      // Park the saturated provider so a later call on this chain skips it (does not hammer it).
      this.#cooldownUntil.set(entry.provider.id, this.#now() + this.#cooldownMs);
      return 'retryable';
    }
    if (error.kind === 'protocol') {
      // Reached only PRE-content: the committed path returns before `#afterFailure` is consulted. Skip the
      // rest of this entry's budget — re-attempting an implementation that cannot keep the grammar is
      // pointless — and give the next provider a turn.
      return 'advance';
    }
    return isRetryable(error.kind) ? 'retryable' : 'fatal';
  }

  /**
   * Invoke the optional credential-refresh hook, treating any throw/rejection as a declined refresh.
   * A misbehaving host hook must not break the runner's error contract (generate rejects with an
   * `LlmProviderError`; stream yields an `error` chunk) — on a hook failure the original auth error
   * stays fatal and the engine surfaces it to the run-event/log, so the throw is deliberately not
   * re-raised here (the runner has no log sink of its own).
   */
  async #refreshCredential(
    hook: (provider: ProviderId) => boolean | Promise<boolean>,
    provider: ProviderId,
  ): Promise<boolean> {
    try {
      return await hook(provider);
    } catch {
      return false;
    }
  }

  /**
   * Re-materialize every durable `handle` media source in `entryReq` to the in-flight source `provider`
   * needs (D8), via the injected {@link FallbackChainOptions.resolveForEgress} hook. Returns the resolved
   * request, or `undefined` when the resolution failed — recorded as a visible failed attempt so the caller
   * advances to the next provider (retryable-advance, ADR-0043 §4). A secret-free message names the reason
   * only — never the handle, a resolved path, a host stack, or bytes.
   */
  async #materializeForEntry(
    entry: FallbackPlanEntry,
    entryReq: LlmRequest,
    run: ChainRun,
  ): Promise<LlmRequest | undefined> {
    try {
      return await this.#materializeMedia(entryReq, entry.provider.id);
    } catch {
      const error = makeLlmError({
        provider: entry.provider.id,
        kind: 'unknown',
        message: 'media re-materialization failed before egress',
      });
      run.lastError = error;
      this.#emit({ ...run.next(entry), error });
      return undefined;
    }
  }

  /**
   * Resolve every `handle` media source in the request to the in-flight source `provider` needs, leaving
   * `base64`/`url` sources untouched. Non-mutating (returns a fresh request) and allocates only when the
   * request actually carries a handle source (the dominant text/base64 case pays a cheap scan).
   */
  async #materializeMedia(req: LlmRequest, provider: ProviderId): Promise<LlmRequest> {
    const resolve = this.#options.resolveForEgress;
    if (resolve === undefined || !hasHandleMedia(req)) {
      return req;
    }
    const messages: LlmMessage[] = [];
    for (const message of req.messages) {
      const content: ContentPart[] = [];
      for (const part of message.content) {
        content.push(
          part.type === 'media' && part.source.kind === 'handle'
            ? { ...part, source: await this.#resolveHandle(part.source.ref, provider, resolve) }
            : part,
        );
      }
      messages.push({ ...message, content });
    }
    return { ...req, messages };
  }

  /** Resolve one handle for `provider`, caching only a non-base64 ref in the byte-free egress sidecar. */
  async #resolveHandle(
    handle: string,
    provider: ProviderId,
    resolve: (handle: string, provider: ProviderId) => Promise<MediaSource>,
  ): Promise<MediaSource> {
    const key = `${provider}\u0000${handle}`; // NUL joiner: cannot occur in a provider id or a handle
    const cached = this.#egressSidecar.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = await resolve(handle, provider);
    if (resolved.kind !== 'base64') {
      // Cache only a provider ref (url/handle) — a base64 source carries bytes and is never cached, so the
      // sidecar stays byte-free (ADR-0043 §4). A later same-provider re-use then skips the re-upload.
      this.#egressSidecar.set(key, resolved);
    }
    return resolved;
  }

  /** Whether to skip an entry without consuming an attempt (cooldown or unmet capability). */
  #skipReason(
    entry: FallbackPlanEntry,
    req: LlmRequest,
    opts?: { readonly streaming?: boolean },
  ): string | undefined {
    const cooldownUntil = this.#cooldownUntil.get(entry.provider.id);
    if (cooldownUntil !== undefined && this.#now() < cooldownUntil) {
      return 'provider in rate-limit cooldown';
    }
    if (opts?.streaming === true && !entry.provider.supports.streaming) {
      return 'provider does not support streaming';
    }
    const unsupported = requestSupportReason(entry.provider.supports, req);
    if (unsupported !== null) {
      // Per-modality (1.AF): an incapable provider is SKIPPED with the specific reason, never silently
      // flattened; the reason matches the adapter-entry `assertMediaCapabilities` throw (one predicate).
      return `provider cannot serve the request: ${unsupported}`;
    }
    return undefined;
  }

  #throwIfAborted(req: LlmRequest, provider: ProviderId): void {
    if (this.#aborted(req)) {
      throw new LlmProviderError(this.#cancelledError(provider));
    }
  }

  #aborted(req: LlmRequest): boolean {
    return req.signal?.aborted === true;
  }

  #cancelledError(provider: ProviderId): LlmError {
    return makeLlmError({ provider, kind: 'cancelled', message: 'request aborted' });
  }

  /**
   * If the request was aborted (a run cancel), a surfaced provider error is a CANCELLATION regardless of how
   * the SDK classified it. A mid-stream abort can reach an adapter as a wrapped connection/transport error
   * (not the SDK's user-abort type), which would otherwise mis-classify as `transport` → `provider_unavailable`
   * — so the cancelled node would read as a provider outage. Reclassifying here (provider-agnostic) keeps a
   * cancel showing as `cancelled` end-to-end.
   */
  /**
   * Open a deadline for one attempt, or `undefined` when the host wired no timer port.
   *
   * The window opens HERE — immediately before the seam call, after `preAttempt`, after media
   * re-materialization, after credential resolution (ADR-0082 §6). Those are Relavium's own work and must
   * not consume the provider's budget.
   */
  #openDeadline(req: LlmRequest): DeadlineScope | undefined {
    const newController = this.#newAbortController;
    const setTimer = this.#setTimer;
    if (newController === undefined || setTimer === undefined) return undefined;
    return openDeadline(this.#attemptTimeoutMs, newController, setTimer, req.signal);
  }

  /**
   * One `next()`, raced against the attempt's absolute deadline.
   *
   * Without a deadline scope this is a plain `await` — the pre-ADR-0082 behaviour, kept for a host that
   * wired no timer port, and the reason the port is optional rather than required.
   */
  async #raceStep(
    iterator: AsyncIterator<StreamChunk>,
    deadline: DeadlineScope | undefined,
  ): Promise<{ kind: 'chunk'; chunk: StreamChunk } | { kind: 'done' } | { kind: 'timeout' }> {
    if (deadline === undefined) {
      const plain = await iterator.next();
      return plain.done === true ? { kind: 'done' } : { kind: 'chunk', chunk: plain.value };
    }
    const raced = await deadline.race(iterator.next());
    if (raced.outcome === 'deadline') {
      // Best-effort teardown, deliberately NOT awaited without bound: a hung iterator must not hang the
      // cleanup too. The guarantee is caller liveness, not resource termination (ADR-0082 §5).
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
      return { kind: 'timeout' };
    }
    return raced.value.done === true
      ? { kind: 'done' }
      : { kind: 'chunk', chunk: raced.value.value };
  }

  /** A deadline abort is `timeout`; a caller abort in the same window stays `cancelled` (ADR-0082 §5). */
  #classifyDeadline(deadline: DeadlineScope | undefined, provider: ProviderId): LlmError {
    return deadline?.classify() === 'caller'
      ? this.#cancelledError(provider)
      : makeLlmError({
          provider,
          kind: 'timeout',
          message: `the provider did not respond within the ${String(this.#attemptTimeoutMs)}ms attempt deadline`,
        });
  }

  #abortAware(error: LlmError, req: LlmRequest, provider: ProviderId): LlmError {
    return this.#aborted(req) ? this.#cancelledError(provider) : disown(error);
  }

  /**
   * The terminal error when every entry was SKIPPED — no provider error exists to surface, so one is
   * synthesized from the skip reasons that were collected on the way past.
   *
   * **The reasons are carried, and the kind is `bad_request`, because this is the common case now** (`CR-51`).
   * A node with no authored `fallback_chain` builds a ONE-entry plan, so a single capability mismatch — a tool
   * grant on a model the catalog says rejects tools, an attached image on a model that rejects attachments —
   * exhausts the chain immediately. Reporting that as `kind: 'unknown'` mapped it to the engine's `internal`
   * code: the opaque-bug bucket, with the precise reason discarded and nothing for the user to act on. The
   * skip is the right behaviour (it is free, where the old path bought a 400) but only if it can be explained,
   * and the explanation was already computed one line away.
   *
   * Deduped, so a five-entry chain that fails the same way five times says it once.
   *
   * **`reasons` is non-empty by construction, so there is no opaque fallback branch.** Reaching here means
   * `run.lastError` was never set, which means no entry was ATTEMPTED, which means every entry was skipped —
   * and the constructor refuses an empty plan. A branch for the empty case would be unreachable code with an
   * unwritable test, which is worse than the invariant stated here.
   */
  #exhaustedError(reasons: readonly string[]): LlmError {
    return makeLlmError({
      provider: this.#exhaustedProvider,
      // The request cannot be served AS WRITTEN — an authoring/config fault, not an engine defect. It maps to
      // the engine's `validation` code, which is what a user can actually act on.
      kind: 'bad_request',
      message: `fallback chain exhausted: no provider could serve the request (${[...new Set(reasons)].join('; ')})`,
    });
  }

  /** Normalize a thrown value into an `LlmError` — `LlmProviderError` carries one; anything else is `unknown`. */
  #errorOf(caught: unknown, provider: ProviderId): LlmError {
    if (caught instanceof LlmProviderError) {
      return caught.llmError;
    }
    return makeLlmError({
      provider,
      kind: 'unknown',
      message: caught instanceof Error ? caught.message : 'unknown provider failure',
      cause: caught,
    });
  }

  /**
   * Wait before re-attempting an entry. The provider's OWN `Retry-After` wins when it sent one (#279): on a
   * rate limit it knows when its window reopens, and computing our own delay was guesswork that either
   * hammered it early or waited longer than needed.
   *
   * Deliberately NO jitter, in either branch. ADR-0040 pins this backoff as deterministic — no jitter, never
   * `Math.random` — so a replay reproduces the same schedule; `retry.ts` follows the same convention. The
   * thundering-herd risk that jitter would address is therefore accepted and left documented rather than
   * silently traded away here: parallel branches that hit one provider's rate limit together will retry
   * together. Revisiting that is an ADR-0040 amendment, not a local edit.
   *
   * The honoured value is already normalized and CLAMPED at the seam ({@link retryAfterMsFromHeaders}): a
   * hostile `retry-after: 999999999` arrives as the 60 s ceiling, not as `undefined`. This docblock used to
   * claim the opposite — that an oversized value was dropped and we fell back to our own curve (#W15-14) —
   * which is exactly the behaviour `clampRetryAfter` was changed AWAY from, because falling back meant
   * retrying after ~250 ms against an endpoint that had just asked for two minutes.
   *
   * That ceiling is why the wait must be abort-aware: 60 s is long enough that a cancel arriving mid-wait
   * has to be honoured. The signal is threaded to the host's timer, which clears it and settles early; the
   * caller's next loop iteration then sees `#aborted(req)` and emits the cancellation.
   */
  async #backoff(
    entry: FallbackPlanEntry,
    retryIndex: number,
    req: LlmRequest,
    error?: LlmError,
  ): Promise<void> {
    const requested = error?.retryAfterMs;
    const delay =
      requested ??
      backoffDelayMs(
        entry.backoff ?? 'exponential',
        retryIndex,
        this.#backoffBaseMs,
        this.#backoffMaxMs,
      );
    await this.#sleep(delay, req.signal);
  }

  async #resolveKey(provider: ProviderId): Promise<string> {
    try {
      return await this.#options.keyFor(provider);
    } catch {
      // A host credential-resolution failure must NEVER surface its (possibly secret-bearing) message
      // as a downstream error (rule 6). Replace it with a fixed, secret-free `auth` failure; the
      // original is dropped — not carried as `cause`, which a sink could serialize.
      throw new LlmProviderError(
        makeLlmError({
          provider,
          kind: 'auth',
          message: `credential resolution failed for provider ${provider}`,
        }),
      );
    }
  }

  /**
   * Emit a success record, folding usage into the cost tracker. `usage`/`cost` are included only when
   * present (a stream that ended without a `stop` chunk has no usage) — `exactOptionalPropertyTypes`
   * forbids an explicit `undefined` on an optional field.
   */
  #emitSuccess(record: AttemptRecord, model: string, usage: Usage | undefined): void {
    if (usage === undefined) {
      this.#emit({ ...record, outcome: 'succeeded' });
      return;
    }
    this.#emitFolded(record, usage, this.#foldUsage(model, usage));
  }

  /**
   * Fold usage into the cost tracker, and return the priced/unpriced outcome.
   *
   * `priceModel` throws `UnknownModelError` for a model id outside the pricing table (a new snapshot, an
   * OpenAI-compatible / self-hosted / custom-base-URL model). The attempt has ALREADY succeeded and its
   * tokens were delivered — an unpriced model must degrade to no cost, never fail the call. Cost accuracy for
   * unlisted models is a pricing-table concern, not a runtime error.
   *
   * NARROW, not bare (#194): the catch used to swallow EVERY exception, so a genuine defect in the money path —
   * a bad `Usage`, a broken overlay, a throwing custom tracker — silently produced "no cost" and looked exactly
   * like an unpriced model. Anything that is not `UnknownModelError` propagates, because a money bug must be
   * loud (`docs/standards/error-handling.md` — no silent catches).
   *
   * Split out of {@link #emitSuccess} for #W15-9: the streaming path needs to guard THIS — an accounting
   * defect — without also swallowing a throw from the attempt observer, which is the consumer's bug and keeps
   * propagating on both paths exactly as before.
   */
  #foldUsage(model: string, usage: Usage): FoldedUsage {
    let cost: CostUpdate | undefined;
    try {
      cost = this.#options.costTracker?.record(model, usage);
    } catch (error_) {
      if (!(error_ instanceof UnknownModelError)) throw error_;
      return { unpriced: true };
    }
    // TWO ways an egress fails to be priced, and they arrive by different routes (ADR-0089 §4). The throw above
    // is an unpriced MODEL — nothing about the call could be priced. This is an unpriced MODALITY on a model
    // that IS priced: the tokens were costed correctly and a produced image/audio/video was not, so
    // `costMicrocents` is a floor. Both are `priced: false` to a reader, because the question that field answers
    // — "is this figure the charge?" — has the same answer either way.
    const unpriced = (cost?.unpricedModalities?.length ?? 0) > 0;
    return { unpriced, ...(cost === undefined ? {} : { cost }) };
  }

  /** Emit the success record for an attempt whose usage has already been folded by {@link #foldUsage}. */
  #emitFolded(record: AttemptRecord, usage: Usage, folded: FoldedUsage): void {
    this.#emit({
      ...record,
      // 2.6.Q's realized-cost half: distinguish "could not price" from "nothing to charge".
      ...(folded.unpriced ? { priced: false as const } : {}),
      outcome: 'succeeded',
      usage,
      ...(folded.cost === undefined ? {} : { cost: folded.cost }),
    });
  }

  #emit(record: AttemptRecord): void {
    this.#options.onAttempt?.(record);
  }
}

/** The outcome of folding one attempt's usage into the cost tracker — `unpriced` when the model is outside
 *  the pricing table (`cost` absent for a reason other than "there was nothing to charge"). */
interface FoldedUsage {
  readonly cost?: CostUpdate;
  readonly unpriced: boolean;
}

/** Mutable per-attempt flag: whether any content chunk has been forwarded (commits the stream). */
interface StreamAttemptState {
  committed: boolean;
}

/**
 * Per-call mutable state: the running (possibly reasoning-stripped) request, the per-provider strip
 * latch, the attempt counter, and the most recent failure for exhaustion surfacing.
 */
class ChainRun {
  #req: LlmRequest;
  #lastProvider: ProviderId | undefined;
  /** `provider\0model` of the last ATTEMPTED entry — the strip latch's real key (ADR-0090, `CR-52`). */
  #lastIssuer: string | undefined;
  #attemptNumber = 0;
  lastError: LlmError | undefined;

  /**
   * Seed the strip latch from the chain instance's cross-call one ([ADR-0039](../../../docs/decisions/0039-same-provider-reasoning-replay.md)):
   * a tool loop is a sequence of separate `generate`/`stream` calls, so the strip latch must survive
   * across them. With the seed, the first attempted entry strips this call's incoming reasoning when
   * the previous call settled on a *different* provider — closing the multi-turn cross-provider replay
   * hole a fresh-per-call latch left open.
   */
  constructor(req: LlmRequest, seedLastIssuer?: string) {
    this.#req = req;
    this.#lastIssuer = seedLastIssuer;
    // Derived so `lastProvider` keeps its meaning for any consumer that only cares about the provider half.
    // PARSED, not asserted: the seed is a string this class folded back from a previous call, and an `as
    // ProviderId` would silently accept a malformed one — then compare unequal to every real id and strip
    // reasoning on every first attempt forever. A failed parse leaves it `undefined`, which is the same
    // no-seed behaviour a first call has (CLAUDE.md rule 1).
    const seededProvider = ProviderIdSchema.safeParse(seedLastIssuer?.split('\u0000')[0]);
    this.#lastProvider = seededProvider.success ? seededProvider.data : undefined;
  }

  /** The `provider\0model` of the last attempted entry — folded back as the next call's seed. */
  get lastIssuer(): string | undefined {
    return this.#lastIssuer;
  }

  /** The provider of the last attempted (non-skipped) entry — the chain folds it back as the next seed. */
  get lastProvider(): ProviderId | undefined {
    return this.#lastProvider;
  }

  /**
   * The request a skip check sees — the running (already-stripped) request with this entry's model,
   * **without** advancing the strip latch. A skipped entry is not a provider boundary, so it must not
   * pollute `#lastProvider` (which would wrongly strip reasoning for a later same-provider entry).
   */
  previewRequest(entry: FallbackPlanEntry): LlmRequest {
    return withEntryModel(this.#req, entry.model);
  }

  /**
   * Begin an entry that will actually be attempted: return the request to send (its model), stripping
   * reasoning parts once a provider boundary is crossed (ADR-0030). The strip mutates the running
   * request permanently for the rest of the call (idempotent), so reasoning never reaches any provider
   * past the originating one. Called once per attempted entry — after the skip check, never for a
   * skipped entry — so the latch tracks only providers that were actually invoked.
   */
  beginEntry(entry: FallbackPlanEntry): LlmRequest {
    const providerId = entry.provider.id;
    const issuer = `${providerId}\u0000${entry.model}`;
    // TWO latches, at deliberately different granularities.
    //
    // REASONING strips on a PROVIDER boundary — ADR-0039's accepted rule, unchanged. Narrowing it to the
    // model would be a real behaviour change to an Accepted decision and belongs in its own ADR, not here.
    //
    // A `tool_call` SIGNATURE strips on a (provider, MODEL) boundary (`CR-52`, ADR-0090). The stricter rule
    // is warranted because the risk profile differs: a `reasoning` part is optional in a response, while a
    // `tool_call` part is UNCONDITIONALLY replayed — it is the conversation — so a token issued by
    // `gemini-3-pro` rides onto an authorable `gemini-2.5-flash` rescue attempt with no boundary to catch it.
    // Gemini validates thought signatures, so that is a `400 INVALID_ARGUMENT`: the failover killing the turn
    // it exists to save, which is the shape `withEntryModel` was written to prevent one field over.
    //
    // Conservative in the other direction too: returning to an entry after a foreign hop strips a token that
    // entry itself issued, so a continuation is LOST rather than rejected. That is the pre-`CR-52` behaviour
    // — never worse — and closing it needs per-part issuer provenance the seam does not carry. Recorded.
    if (this.#lastProvider !== undefined && this.#lastProvider !== providerId) {
      this.#req = stripReasoningParts(this.#req);
    }
    if (this.#lastIssuer !== undefined && this.#lastIssuer !== issuer) {
      this.#req = stripToolCallSignatures(this.#req);
    }
    this.#lastProvider = providerId;
    this.#lastIssuer = issuer;
    return withEntryModel(this.#req, entry.model);
  }

  /** Allocate the next 1-based attempt record skeleton for this entry. */
  next(
    entry: FallbackPlanEntry,
    extra?: Pick<AttemptRecord, 'outcome' | 'skipReason'>,
  ): AttemptRecord {
    this.#attemptNumber += 1;
    return {
      attemptNumber: this.#attemptNumber,
      provider: entry.provider.id,
      model: entry.model,
      outcome: extra?.outcome ?? 'failed',
      ...(extra?.skipReason === undefined ? {} : { skipReason: extra.skipReason }),
    };
  }
}

/**
 * Single-shot façade over {@link FallbackChain} for the common non-streaming case — constructs a
 * transient chain and runs `generate`. Use the class directly when you need streaming or want the
 * per-provider rate-limit cooldown to persist across calls.
 */
export function withFallback(
  plan: readonly FallbackPlanEntry[],
  req: LlmRequest,
  options: FallbackChainOptions,
): Promise<LlmResult> {
  return new FallbackChain(plan, options).generate(req);
}
