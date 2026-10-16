import type { CliInvocation } from '../process/invocation.js';
import { SessionHostOwner } from '../chat/session-host-owner.js';
import { SessionSurfaceLifetime } from '../chat/session-surface-lifetime.js';
import { runSessionPrompt } from '../chat/session-prompt.js';
import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';

import type { SessionStreamHandleEvent } from '@relavium/core';

import { nonInteractiveApprovalPrompt } from '../chat/chat-mode.js';
import { applyChatMode, makeChatModeEnv } from '../chat/chat-mode-host.js';
import { cassetteResolver, loadCassette } from '../chat/fixture.js';
import { onceEffortNotice } from '../chat/effort-notice.js';
import { buildChatSession, type BuiltChatSession } from '../chat/session-host.js';
import { createConsentGate } from '../engine/mcp-consent-gate.js';

import type { StdioConsentGate } from '../engine/mcp-servers.js';
import { createBoundConsentPrompter } from '../mcp/consent-prompt.js';
import { loadResolvedConfig } from '../config/load.js';
import { admitFsInvocation, admitChatFsPolicy } from '../engine/tool-host/fs-admission.js';
import { surfaceMcpSkipped } from '../engine/mcp-servers.js';
import { loadUserPricingOverlay } from '../engine/pricing-overlay.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { makePlainPrinter } from './chat.js';
import { stringifyJsonLine } from '../render/sanitize.js';
import {
  createEffectJournalPort,
  createEffectJournalStore,
  createSessionUsageStore,
  SessionEffectTurnError,
  type SessionUsageReceipt,
} from '@relavium/db';
import { openSessionStore } from '../history/session-open.js';
import { sweepOneShotSessionEffects } from '../engine/effect-retention.js';
import type { UsageInvocation } from '@relavium/shared';

/**
 * `relavium agent run <agent>` (2.Q) — invoke a single agent **one-shot** (non-interactive) on the same
 * `AgentSession` infra: a chat session with one turn, then exit. The user prompt is read from **stdin** (the
 * `echo … | relavium agent run` idiom); `--fixture <path>` replays a recorded cassette so the run is
 * deterministic + offline. `--json` emits the NDJSON `session:*` stream; otherwise the assistant reply streams
 * in human form. Its transcript is not persisted or resumable; hidden owner metadata records usage coverage,
 * realized cost and effects (ADR-0104). Exit: the turn's outcome — `0` on
 * success, `1` on a classified turn error; an invocation fault (no prompt / unknown agent / bad cassette /
 * `--input`) is `2`. Unexpected infrastructure failure is `9`, with cleanup owned by the original invocation.
 * `--input` is **reserved** — rejected until session `{{ctx.*}}` prompt interpolation lands (deferred-tasks.md).
 */

export interface AgentRunCommandArgs {
  /** `<agent>` (required) — a `.agent.yaml` path or a `.relavium/` agent id. */
  readonly agent: string;
  /** `--input k=v` (repeatable) — RESERVED; currently rejected (session prompt interpolation is a pending engine change). */
  readonly input: readonly string[];
  /** `--fixture <path>` — replay a recorded LLM cassette (deterministic, offline). */
  readonly fixture?: string;
  /**
   * `--allow-mcp-stdio <digest>`, repeatable
   * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §6) — authorizes a
   * stdio MCP server for THIS invocation and writes no grant. On `agent run` for the same reason as on
   * `run`: both are the invocations a CI definition drives, where there is no one to ask.
   */
  readonly allowMcpStdio: readonly string[];
}

export interface AgentRunCommandDeps {
  /** The original bootstrap invocation; native authority stays host-only. */
  readonly invocation?: CliInvocation;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable provider seam (tests). Ignored when `--fixture` is given (the cassette resolver always wins). */
  readonly providers?: ProviderResolver;
  /** Injectable session builder (tests). Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
  /**
   * Injectable consent gate (ADR-0084 §1) — the DEFAULT is the real one, so an un-wired production path is
   * a deliberate choice rather than an omission. A fixture supplies one that never prompts.
   */
  readonly consentGate?: StdioConsentGate;
  /** The MCP named-secret resolver (2.R Step 4) — production injects the keychain-backed one; default env-only. */
  readonly mcpSecretResolver?: McpSecretResolver;
  readonly resolveKeys?: () => Pick<AgentRunCommandDeps, 'providers' | 'mcpSecretResolver'>;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export async function agentRunCommand(
  args: AgentRunCommandArgs,
  deps: AgentRunCommandDeps,
): Promise<ExitCode> {
  const lifetime = new SessionSurfaceLifetime(deps.invocation, 'agent');
  return lifetime.execute(() =>
    agentRunOwned(
      args,
      {
        ...deps,
        invocation: lifetime.invocation,
        io: {
          ...deps.io,
          // Best-effort retention may consume a warning refusal, but actual output remains an
          // invocation-owned tail. Neither a pending delivery nor a broken sink is a completion ACK.
          writeErrAcknowledged: (text) =>
            lifetime.work.work.retainWork(async () => {
              try {
                await deps.io.writeErrAcknowledged(text);
              } catch (cause) {
                lifetime.work.failure(cause);
                throw cause;
              }
            }),
        },
      },
      lifetime,
    ),
  );
}

async function agentRunOwned(
  args: AgentRunCommandArgs,
  deps: AgentRunCommandDeps,
  lifetime: SessionSurfaceLifetime,
): Promise<ExitCode> {
  const hostOwner = new SessionHostOwner(lifetime.invocation, 'agent');
  let openedJournal: ReturnType<typeof openSessionStore> | undefined;
  try {
    const nativeProcesses = nativeProcessesForInvocation(deps.invocation);
    const grants = admitFsInvocation(deps.global);
    const now = deps.now ?? Date.now;
    const uuid = deps.uuid ?? randomUUID;
    const { config, projectConfigDir, homeDir } = loadResolvedConfig({
      cwd: deps.global.cwd,
      configPath: deps.global.configPath,
    });

    const fsPolicy = admitChatFsPolicy(grants, deps.global.cwd, config.chat.extraRoots);

    // Validate the invocation + read the one-shot prompt from stdin (the two pre-run faults live in the helper).
    const message = await resolveOneShotInput(args, deps, lifetime);
    lifetime.work.assertAdmitting();

    // A `--fixture` replays a cassette (offline, no keychain) and takes precedence over any injected/real seam;
    // otherwise tests inject `providers`, and production resolves keys via the env/keychain (like `relavium run`).
    const offline = args.fixture !== undefined;
    const keys = offline ? undefined : deps.resolveKeys?.();
    const providers =
      args.fixture === undefined
        ? (deps.providers ?? keys?.providers ?? createProviderResolver(deps.io.env))
        : cassetteResolver(loadCassette(args.fixture, deps.global.cwd));
    // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — so a one-shot live turn enforces + tracks a user-priced
    // model. SKIPPED under `--fixture`: cassette pricing stays deterministic and fully offline. Usage coverage
    // and realized attribution still use the local database, without consulting the user pricing overlay.
    const resolvePrice = offline
      ? undefined
      : loadUserPricingOverlay(homeDir, deps.io, deps.invocation);

    // An unknown `<agent>` (path or id) throws a typed CliError here (exit 2), before any turn. The build is
    // async (2.R): it connects the agent's inline stdio `mcp_servers` (a connect failure is a fail-loud exit-2
    // CliError, cause stripped) before the one-shot turn runs. In `--fixture` (cassette) mode the run must be
    // FULLY offline: no `[[mcp_servers]]` registrations and an env-only secret resolver (never the keychain).
    const built = await hostOwner.build((workOwner) =>
      (deps.buildSession ?? buildChatSession)({
        workOwner,
        ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
        chat: config.chat,
        fsPolicy,
        afterTurnCompaction: false, // One-shot output has no next turn; retain active summary permission.
        ...(config.maxTokensEstimate === undefined
          ? {}
          : { maxTokensEstimate: config.maxTokensEstimate }),
        // **Consent before any stdio MCP spawn** (ADR-0084 §1). A one-shot `agent run` opens an agent artifact
        // — often an imported one — which is exactly the case the gate exists for; `--fixture` replays offline
        // and declares no servers, so the gate never fires there.
        mcpArtifact: args.agent,
        consentGate:
          deps.consentGate ??
          createConsentGate({
            io: deps.io,
            global: deps.global,
            homeDir,
            allowedDigests: args.allowMcpStdio,
            signal: workOwner.signal,
            prompt: (subject) => {
              const prompt = createBoundConsentPrompter(deps.io);
              return runSessionPrompt(
                lifetime.invocation,
                deps.io,
                workOwner.assertAdmitting,
                workOwner.failure,
                (signal) => prompt(subject, { signal }),
              );
            },
          }),
        // ADR-0071 §6: a one-shot invoke has no transcript and no picker, so a withheld tier would otherwise vanish
        // completely — the turn runs, the authored knob does nothing, and the bill arrives at the provider's default.
        // STDERR, never stdout: `--json` owns stdout, and a warning line mid-stream is a parse error downstream.
        onEffortWithheld: onceEffortNotice((note) => deps.io.writeErr(`warning: ${note}\n`)),
        // stderr, never stdout: `--json` owns stdout and a notice must not corrupt the NDJSON stream.
        onListenerError: (note) => deps.io.writeErr(`warning: ${note}\n`),
        onUnpriced: (note) => deps.io.writeErr(`warning: ${note}\n`),
        agentRef: args.agent,
        cwd: deps.global.cwd,
        projectConfigDir,
        now,
        uuid,
        providers,
        mcpSecretResolver: offline
          ? createMcpSecretResolver(deps.io.env)
          : (deps.mcpSecretResolver ??
            keys?.mcpSecretResolver ??
            createMcpSecretResolver(deps.io.env)),
        mcpRegistrations: offline ? [] : config.mcpServers,
        ...(resolvePrice === undefined ? {} : { resolvePrice }),
        // FULLY offline in `--fixture` (cassette) mode: disable inbound MCP entirely so an agent's inline
        // `mcp_servers` are never connected (no config build, no spawn, no dial). The cassette already carries any
        // recorded tool results, so the replay needs no live MCP.
        ...(offline ? { disableMcp: true } : {}),
        mcpConnectSignal: workOwner.signal,
      }),
    );

    // ADR-0074 §4: `agent run` has no resumable transcript or restored cap. Its hidden ADR-0104 owner records
    // coverage and realized money, while conservative commitments retain the explicit one-shot no-op. Attach an
    // explicit no-op so the governor's emit resolves: without it every commitment would reject, mark the session
    // durability-broken, and the §2 barrier would fail a turn for a session nobody was ever going to resume. The
    // in-memory debit still consumes cap capacity for this process, which is the whole of what a one-shot needs.
    built.governor?.attachConservativeWriter(() => Promise.resolve());

    // **ADR-0074 §4's no-op precedent does NOT transfer to effects, and the difference is the whole point.**
    // A conservative commitment has nowhere to go because nothing will ever resume this invocation. An external
    // effect is carried forward by the TARGET, not by the run — a ticket filed here still exists tomorrow — so a
    // no-op journal would be fail-open on exactly the guarantee CR-12 exists to give, and leaving it unattached
    // would refuse every effectful tool on this surface.
    //
    // The same hidden owner supplies effect correlation and durable usage coverage. It never grants transcript
    // discovery or resume permission; an exact opaque owner receipt is required to attach usage writes.
    // The host reservation already owns every entered builder/MCP operation. The outer surface root also
    // owns this database from acquisition through actual host cleanup, including setup failures before a turn.
    lifetime.work.assertAdmitting();
    const journalStore = openSessionStore(homeDir);
    openedJournal = journalStore;
    let ownedEffectSessionId: string | undefined;
    const usageStore = createSessionUsageStore(journalStore.db);
    const receipts = new Map<UsageInvocation, SessionUsageReceipt>();
    try {
      // A fresh hidden owner retains usage uncertainty without a transcript or resume privilege.
      const owner = (() => {
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0)
          throw new CliError('cli_internal', '');
        try {
          return usageStore.createFreshOneShotOwner({ sessionId: built.sessionId, now: timestamp });
        } catch (cause) {
          if (!(cause instanceof SessionEffectTurnError) || cause.code !== 'history_invalid')
            throw cause;
          throw new CliError(
            'invalid_invocation',
            'one-shot session identity could not be reserved',
            { cause },
          );
        }
      })();
      ownedEffectSessionId = owner.sessionId;
      const producerId = randomUUID();
      let dispatch = 0;
      let failure: Error | undefined;
      const write = (operation: () => void): void => {
        if (failure !== undefined) throw failure;
        try {
          operation();
        } catch (cause) {
          failure = cause instanceof Error ? cause : new Error('One-shot usage persistence failed');
          throw failure;
        }
      };
      built.attachDurabilityProbe(() => failure);
      built.attachUsageWriter({
        readSnapshot: () => {
          const snapshot = journalStore.store.loadSessionCostBreakdown(owner.sessionId);
          return {
            cumulativeCostMicrocents: snapshot.totalCostMicrocents,
            cumulativeUnpricedCalls: snapshot.rows.reduce((sum, row) => sum + row.unpricedCalls, 0),
            usageCoverage: snapshot.coverage,
          };
        },
        initialCoverage: () => {
          const snapshot = usageStore.loadCoverage(owner.sessionId);
          if (snapshot === undefined) throw new Error('One-shot usage owner unavailable');
          return { ...snapshot, started: true, highWater: 0 };
        },
        begin: (draft) => {
          let receipt: SessionUsageReceipt | undefined;
          write(() => {
            receipt = usageStore.beginInvocation(
              {
                sessionId: owner.sessionId,
                model: draft.model,
                producerId,
                // The producer scopes this ordinal; authored agent IDs are unbounded business identity.
                dispatchId: String(++dispatch),
                round: draft.round,
                chainAttempt: draft.chainAttempt,
              },
              owner,
            );
          });
          if (receipt === undefined) throw new Error('One-shot usage receipt unavailable');
          receipts.set(receipt.invocation, receipt);
          return Promise.resolve(receipt.invocation);
        },
        disposition: (draft) => {
          const receipt = receipts.get(draft.invocation);
          if (receipt === undefined) throw new Error('One-shot usage receipt unavailable');
          write(() => {
            usageStore.disposition(receipt, draft.disposition);
            if (draft.receiptPending !== true) {
              usageStore.retire(receipt);
              receipts.delete(draft.invocation);
            }
          });
        },
        record: (draft) => {
          const receipt =
            draft.invocation === undefined ? undefined : receipts.get(draft.invocation);
          if (receipt === undefined)
            throw new Error('One-shot actual cost requires its live receipt');
          write(() => {
            const accepted = journalStore.store.recordSessionCost({
              id: randomUUID(),
              sessionId: owner.sessionId,
              model: draft.model,
              inputTokens: draft.inputTokens,
              outputTokens: draft.outputTokens,
              costMicrocents: draft.costMicrocents,
              priced: draft.priced,
              ts: now(),
              usageReceipt: receipt,
            });
            if (!accepted) throw new Error('One-shot actual cost acknowledgement refused');
            receipts.delete(receipt.invocation);
          });
        },
      });
      built.attachEffectTurnAllocator((id) => {
        if (id !== owner.sessionId) throw new Error('One-shot effect owner mismatch');
        return owner.effectTurnKey;
      });
      built.attachEffectJournal((correlation) =>
        createEffectJournalPort(
          createEffectJournalStore(journalStore.db, { uuid: randomUUID, now: Date.now }),
          correlation,
          { providerAttempt: 1, toolCallId: 'agent-run' },
        ),
      );
      // Render the live stream + run the single turn + tear down — a classified turn failure maps to exit 1.
      hostOwner.work.assertAdmitting();
      const turnErrorCode = await hostOwner.work.enter(() => runOneShotTurn(built, message, deps));
      return turnErrorCode === undefined ? EXIT_CODES.success : EXIT_CODES.workflowFailed;
    } catch (cause) {
      // Setup can fail before a turn root exists. Observe the original fault BEFORE awaiting host cleanup:
      // a held MCP close must not delay starting the common fatal budget. Known refusals stay classified.
      hostOwner.work.failure(cause);
      throw cause;
    } finally {
      // Real root/producer/accounting/MCP cleanup precedes retention, receipt retirement and DB close.
      await hostOwner.work.close();
      if (
        lifetime.invocation.registry.budget.remainingMs() !== 0 &&
        ownedEffectSessionId !== undefined
      )
        sweepOneShotSessionEffects(deps.io, journalStore.db, ownedEffectSessionId);
      for (const receipt of receipts.values()) usageStore.retire(receipt);
      receipts.clear();
    }
  } catch (cause) {
    // Recover only the exact preparation owner's cancellation identity. An unrelated fault racing
    // an aborted signal keeps its own classification and starts the original fatal budget.
    if (hostOwner.work.isStoppedFailure(cause)) lifetime.work.assertAdmitting();
    if (!lifetime.work.isStoppedFailure(cause)) lifetime.work.failure(cause);
    throw cause;
  } finally {
    await hostOwner.work.close();
    if (openedJournal !== undefined) {
      try {
        openedJournal.close();
      } catch (cause) {
        lifetime.work.cleanupUncertain(cause);
      }
    }
  }
}

/** Validate the one-shot invocation and read the prompt from stdin — the two pre-run faults (exit-2 CliError). */
async function resolveOneShotInput(
  args: AgentRunCommandArgs,
  deps: AgentRunCommandDeps,
  lifetime: SessionSurfaceLifetime,
): Promise<string> {
  // `--input k=v` is REJECTED for now: a session does not yet interpolate `{{ctx.*}}` into the agent prompt
  // (the engine passes `system_prompt` verbatim; wiring `resolveTemplate` into the session turn core is a
  // deferred, security-relevant change — it would also throw on existing prompts' unresolved placeholders).
  // Exposing an inert flag is misleading, so fail loud until the interpolation wiring lands. *(deferred-tasks.md)*
  if (args.input.length > 0) {
    throw new CliError(
      'invalid_invocation',
      '`--input` is not supported yet — a session does not interpolate {{ctx.*}} into the agent prompt (a tracked engine follow-up). Omit it for now.',
    );
  }
  // The one-shot prompt is the piped stdin; an empty stdin is a clean invocation fault (nothing to run).
  const message = (
    await readAllStdin(deps.io.stdin, {
      signal: lifetime.work.signal,
      onFailure: lifetime.work.failure,
    })
  ).trim();
  if (message.length === 0) {
    throw new CliError(
      'invalid_invocation',
      'no input message — pipe the prompt on stdin (e.g. `echo "…" | relavium agent run <agent>`)',
    );
  }
  return message;
}

/**
 * Render the live stream (NDJSON under `--json`, else the plain token/tool printer), run the single turn, and
 * return the classified turn-error code (or `undefined` on success). Cancellation and subscription release
 * belong to this turn; the creation owner separately joins actual producer/accounting/MCP cleanup. An
 * unexpected failure is reported before cancellation and never converted to a classified turn outcome.
 */
async function runOneShotTurn(
  built: BuiltChatSession,
  message: string,
  deps: AgentRunCommandDeps,
): Promise<string | undefined> {
  let turnErrorCode: string | undefined;
  const renderer: (event: SessionStreamHandleEvent) => void = deps.global.json
    ? (event) => deps.io.writeOut(`${stringifyJsonLine(event)}\n`)
    : // A ONE-SHOT: the session is cancelled in `finally` right after, so suppress the session-continuity recovery
      // hint (2.5.H) — "the session is still active / resend / `/compact`" would be false with no live REPL.
      makePlainPrinter(deps.io, false);
  let unsubscribe: () => void = () => {};
  try {
    surfaceMcpSkipped(deps.io, built.mcpSkipped);
    unsubscribe = built.handle.subscribe((event) => {
      renderer(event);
      if (event.type === 'session:turn_completed' && event.error !== undefined) {
        turnErrorCode = event.error.code;
      }
    });
    // ADR-0057: `agent run` is a NON-interactive one-shot over the SAME full-capability chat-read-write host
    // (session-host.ts). There is no user to approve a governed action, so apply the fail-closed `ask` regime
    // BEFORE the first turn — every governed dispatch (write / egress / a model-command process) is denied,
    // restoring the pre-4b fail-closed behavior (read-only tools still work). A deliberate author-trusted
    // one-shot would be a separate, security-reviewed decision using the workflow-read-write profile, not this.
    const modeEnv = makeChatModeEnv({
      session: built.session,
      tools: built.tools,
      workspaceDir: built.context.workingDir,
      ...(built.fsPolicy === undefined ? {} : { fsPolicy: built.fsPolicy }),
      // The one canonical no-TTY fail-closed policy (Step 14) — a one-shot has no user to approve, so every
      // governed dispatch is denied (never a hang / auto-approve). Shared with the non-interactive chat driver.
      prompt: nonInteractiveApprovalPrompt('in a one-shot agent run'),
    });
    applyChatMode(modeEnv, 'ask');
    built.session.start();
    await built.session.sendMessage(message);
  } catch (cause) {
    built.workOwner?.failure(cause);
    throw cause;
  } finally {
    try {
      built.session.cancel();
    } catch (cause) {
      built.workOwner?.cleanupUncertain(cause);
    } finally {
      unsubscribe();
    }
  }
  return turnErrorCode;
}

/** Read the whole input stream to EOF as UTF-8 text (the one-shot prompt). Exported for a focused unit test. */
export async function readAllStdin(
  stream: NodeJS.ReadableStream,
  options?: { readonly signal: AbortSignal; readonly onFailure: (cause: unknown) => void },
): Promise<string> {
  // Decode binary chunks through a StringDecoder so a multi-byte UTF-8 character split ACROSS a chunk boundary
  // is buffered (not mangled into replacement chars); `decoder.end()` flushes any trailing partial sequence. A
  // test stream yields strings (a Buffer is itself a Uint8Array subclass), handled by the String fallback.
  const decoder = new StringDecoder('utf8');
  let data = '';
  const signal = options?.signal;
  signal?.throwIfAborted();
  const native = stream instanceof Readable ? stream : undefined;
  const cancelled = new Error('One-shot input stopped.');
  let cancellationEntered = false;
  let closed: Promise<void> | undefined;
  let acknowledgeClose: () => void = () => undefined;
  const onClose = (): void => acknowledgeClose();
  const abort = (): void => {
    if (native === undefined || cancellationEntered) return;
    cancellationEntered = true;
    closed = new Promise((resolve) => {
      acknowledgeClose = resolve;
    });
    native.once('close', onClose);
    if (native.closed) acknowledgeClose();
    try {
      native.destroy(cancelled);
    } catch (cause) {
      // A throwing cancellation is not close ACK. Report it before waiting on the retained read.
      options?.onFailure(cause);
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      data += chunk instanceof Uint8Array ? decoder.write(Buffer.from(chunk)) : String(chunk);
    }
    signal?.throwIfAborted();
    data += decoder.end();
    return data;
  } catch (cause) {
    // Only this owned native destroy identity can recover the invocation's cancellation reason.
    // An unrelated read fault racing an aborted signal keeps its original infrastructure diagnosis.
    if (cause === cancelled) signal?.throwIfAborted();
    options?.onFailure(cause);
    throw cause;
  } finally {
    signal?.removeEventListener('abort', abort);
    await closed;
    native?.removeListener('close', onClose);
  }
}
