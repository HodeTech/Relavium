import type { BackoffStrategy } from '@relavium/shared';

import type { CostTracker, CostUpdate } from './cost-tracker.js';
import { isRetryable, LlmProviderError, makeLlmError } from './llm-error.js';
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
import { supportsRequest } from './capabilities.js';

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
   */
  readonly costTracker?: CostTracker;
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
   */
  readonly sleep: (ms: number) => Promise<void>;
  /** Injectable clock for cooldown bookkeeping (default: `Date.now`, an ECMAScript primitive). */
  readonly now?: () => number;
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
}

const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 8_000;
const DEFAULT_COOLDOWN_MS = 30_000;

/** What a classified failure means for the chain (a pure function of `LlmError.kind`). */
type Verdict = 'fatal' | 'retryable' | 'auth-refreshed';

/**
 * Strip every `reasoning` content part from a request's messages — a pure transform producing a new
 * request (the input is never mutated). Dropping the whole part removes its ephemeral `signature`
 * along with `text`/`redacted`; a message left with no content is dropped. Runs on a cross-provider
 * advance so a provider-signed reasoning block never crosses a provider boundary (ADR-0030).
 */
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

/** A content chunk commits a stream — anything other than the terminal `stop`/`error` arms. */
function isContentChunk(chunk: StreamChunk): boolean {
  return chunk.type !== 'stop' && chunk.type !== 'error';
}

/** What one `generate` attempt produced. */
type GenerateAttempt =
  | { readonly status: 'success'; readonly result: LlmResult }
  | { readonly status: 'error'; readonly error: LlmError };

export class FallbackChain {
  readonly #plan: readonly FallbackPlanEntry[];
  readonly #options: FallbackChainOptions;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #cooldownMs: number;
  /** Per-provider cooldown expiry (ms), persisted across calls on this instance (rate-limit nuance). */
  readonly #cooldownUntil = new Map<ProviderId, number>();
  // The cross-CALL reasoning strip latch (ADR-0039). Unlike the per-call `ChainRun.#lastProvider`,
  // this survives across generate/stream calls so a multi-turn tool loop on ONE chain instance strips
  // a prior provider's signed reasoning before it can reach a different provider's next call. A chain
  // instance is **single-flight by contract** — one node execution's *sequential* tool loop; concurrent
  // generate/stream on the same instance would race this latch, so concurrent agent vertices each get
  // their own chain (the AgentRunner builds one per node execution — ADR-0038).
  #lastProviderAcrossCalls: ProviderId | undefined;
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
  }

  /**
   * Run the chain for a non-streaming request. Returns the first entry's `LlmResult`; throws an
   * `LlmProviderError` carrying the classified `LlmError` once the chain is exhausted or a fatal
   * error stops it. Each attempt is reported via `onAttempt`; per-attempt usage is recorded against
   * that attempt's model so cost stays accurate across a failover.
   */
  async generate(req: LlmRequest): Promise<LlmResult> {
    const run = new ChainRun(req, this.#lastProviderAcrossCalls);
    try {
      for (const entry of this.#plan) {
        this.#throwIfAborted(req, entry.provider.id);
        const skip = this.#skipReason(entry, run.previewRequest(entry));
        if (skip !== undefined) {
          this.#emit(run.next(entry, { outcome: 'skipped', skipReason: skip }));
          continue;
        }
        const entryReq = run.beginEntry(entry); // strips on a provider boundary — only for attempted entries
        const result = await this.#runEntryGenerate(entry, entryReq, req, run);
        if (result !== undefined) {
          return result;
        }
      }
      throw new LlmProviderError(run.lastError ?? this.#exhaustedError());
    } finally {
      this.#lastProviderAcrossCalls = run.lastProvider; // fold the call's latch back for the next call
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
      if (verdict === 'auth-refreshed') {
        bonus += 1; // +1 attempt ON TOP of the configured budget; retry now (a fresh credential)
        continue;
      }
      if (attempt < budget + bonus) {
        await this.#backoff(entry, attempt - 1);
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
    try {
      for (const entry of this.#plan) {
        if (this.#aborted(req)) {
          yield { type: 'error', error: this.#cancelledError(entry.provider.id) };
          return;
        }
        const skip = this.#skipReason(entry, run.previewRequest(entry), { streaming: true });
        if (skip !== undefined) {
          this.#emit(run.next(entry, { outcome: 'skipped', skipReason: skip }));
          continue;
        }
        const entryReq = run.beginEntry(entry); // strips on a provider boundary — only for attempted entries
        const action = yield* this.#runEntryStream(entry, entryReq, req, run);
        if (action === 'done') {
          return;
        }
      }
      yield { type: 'error', error: run.lastError ?? this.#exhaustedError() };
    } finally {
      this.#lastProviderAcrossCalls = run.lastProvider; // fold the call's latch back for the next call
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
      if (verdict === 'auth-refreshed') {
        bonus += 1; // +1 attempt ON TOP of the configured budget; retry now (a fresh credential)
        continue;
      }
      if (attempt < budget + bonus) {
        await this.#backoff(entry, attempt - 1);
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
    try {
      const maxTokens = entryReq.maxTokens;
      await this.#options.preAttempt?.({
        model: entry.model,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      });
      const key = await this.#resolveKey(entry.provider.id);
      const result = await entry.provider.generate(entryReq, key);
      this.#emitSuccess(record, entry.model, result.usage);
      return { status: 'success', result };
    } catch (err) {
      const error = this.#errorOf(err, entry.provider.id);
      this.#emit({ ...record, outcome: 'failed', error });
      return { status: 'error', error };
    }
  }

  /**
   * Execute one `stream` attempt: forward every chunk, flip `state.committed` on the first content
   * chunk, and surface a post-content failure inline (no failover). Returns the pre-content failure
   * to fail over on, or `undefined` if the stream completed (a success was already emitted, or a
   * post-content failure was surfaced).
   */
  async *#runStreamAttempt(
    entry: FallbackPlanEntry,
    entryReq: LlmRequest,
    record: AttemptRecord,
    state: StreamAttemptState,
  ): AsyncGenerator<StreamChunk, LlmError | undefined> {
    let usage: Usage | undefined;
    try {
      const maxTokens = entryReq.maxTokens;
      await this.#options.preAttempt?.({
        model: entry.model,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      });
      const key = await this.#resolveKey(entry.provider.id);
      for await (const chunk of entry.provider.stream(entryReq, key)) {
        if (chunk.type === 'error') {
          this.#emit({ ...record, outcome: 'failed', error: chunk.error });
          if (state.committed) {
            yield chunk; // surface a mid-stream failure; the node-retry layer (1.S) owns it
            return undefined;
          }
          return chunk.error; // pre-content failure → caller decides failover
        }
        if (chunk.type === 'stop') {
          usage = chunk.usage;
        }
        state.committed = state.committed || isContentChunk(chunk);
        yield chunk;
      }
    } catch (err) {
      const error = this.#errorOf(err, entry.provider.id);
      this.#emit({ ...record, outcome: 'failed', error });
      if (state.committed) {
        yield { type: 'error', error };
        return undefined;
      }
      return error; // pre-content throw → caller decides failover
    }
    this.#emitSuccess(record, entry.model, usage);
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
    if (!supportsRequest(entry.provider.supports, req)) {
      return 'provider does not support a required capability';
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

  #exhaustedError(): LlmError {
    // No real provider error to surface (every entry was skipped): synthesize a fatal one.
    return makeLlmError({
      provider: this.#exhaustedProvider,
      kind: 'unknown',
      message: 'fallback chain exhausted: no provider could serve the request',
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

  async #backoff(entry: FallbackPlanEntry, retryIndex: number): Promise<void> {
    const delay = backoffDelayMs(
      entry.backoff ?? 'exponential',
      retryIndex,
      this.#backoffBaseMs,
      this.#backoffMaxMs,
    );
    await this.#sleep(delay);
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
    // Best-effort: `priceModel` throws `UnknownModelError` for a model id outside the pricing table
    // (a new snapshot, an OpenAI-compatible / self-hosted / custom-base-URL model). The attempt has
    // ALREADY succeeded and its tokens were delivered — an unpriced model must degrade to no cost,
    // never fail the call. Cost accuracy for unlisted models is a pricing-table concern, not a runtime error.
    let cost: CostUpdate | undefined;
    try {
      cost = this.#options.costTracker?.record(model, usage);
    } catch {
      cost = undefined;
    }
    this.#emit({
      ...record,
      outcome: 'succeeded',
      usage,
      ...(cost === undefined ? {} : { cost }),
    });
  }

  #emit(record: AttemptRecord): void {
    this.#options.onAttempt?.(record);
  }
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
  #attemptNumber = 0;
  lastError: LlmError | undefined;

  /**
   * Seed `#lastProvider` from the chain instance's cross-call latch ([ADR-0039](../../../docs/decisions/0039-same-provider-reasoning-replay.md)):
   * a tool loop is a sequence of separate `generate`/`stream` calls, so the strip latch must survive
   * across them. With the seed, the first attempted entry strips this call's incoming reasoning when
   * the previous call settled on a *different* provider — closing the multi-turn cross-provider replay
   * hole a fresh-per-call latch left open.
   */
  constructor(req: LlmRequest, seedLastProvider?: ProviderId) {
    this.#req = req;
    this.#lastProvider = seedLastProvider;
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
    return { ...this.#req, model: entry.model };
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
    if (this.#lastProvider !== undefined && this.#lastProvider !== providerId) {
      this.#req = stripReasoningParts(this.#req);
    }
    this.#lastProvider = providerId;
    return { ...this.#req, model: entry.model };
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
