import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import type { SessionStreamHandleEvent } from '@relavium/core';

import { applyChatMode, makeChatModeEnv } from '../chat/chat-mode-host.js';
import { cassetteResolver, loadCassette } from '../chat/fixture.js';
import { buildChatSession, type BuiltChatSession } from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
import { surfaceMcpSkipped } from '../engine/mcp-servers.js';
import { loadUserPricingOverlay } from '../engine/pricing-overlay.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { makePlainPrinter } from './chat.js';

/**
 * `relavium agent run <agent>` (2.Q) — invoke a single agent **one-shot** (non-interactive) on the same
 * `AgentSession` infra: a chat session with one turn, then exit. The user prompt is read from **stdin** (the
 * `echo … | relavium agent run` idiom); `--fixture <path>` replays a recorded cassette so the run is
 * deterministic + offline. `--json` emits the NDJSON `session:*` stream; otherwise the assistant reply streams
 * in human form. Unlike the REPL it is NOT persisted (a stateless invoke). Exit: the turn's outcome — `0` on
 * success, `1` on a turn error; an invocation fault (no prompt / unknown agent / bad cassette / `--input`) is
 * `2`. `--input` is **reserved** — rejected until session `{{ctx.*}}` prompt interpolation lands (deferred-tasks.md).
 */

export interface AgentRunCommandArgs {
  /** `<agent>` (required) — a `.agent.yaml` path or a `.relavium/` agent id. */
  readonly agent: string;
  /** `--input k=v` (repeatable) — RESERVED; currently rejected (session prompt interpolation is a pending engine change). */
  readonly input: readonly string[];
  /** `--fixture <path>` — replay a recorded LLM cassette (deterministic, offline). */
  readonly fixture?: string;
}

export interface AgentRunCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable provider seam (tests). Ignored when `--fixture` is given (the cassette resolver always wins). */
  readonly providers?: ProviderResolver;
  /** Injectable session builder (tests). Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
  /** The MCP named-secret resolver (2.R Step 4) — production injects the keychain-backed one; default env-only. */
  readonly mcpSecretResolver?: McpSecretResolver;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export async function agentRunCommand(
  args: AgentRunCommandArgs,
  deps: AgentRunCommandDeps,
): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });

  // Validate the invocation + read the one-shot prompt from stdin (the two pre-run faults live in the helper).
  const message = await resolveOneShotInput(args, deps);

  // A `--fixture` replays a cassette (offline, no keychain) and takes precedence over any injected/real seam;
  // otherwise tests inject `providers`, and production resolves keys via the env/keychain (like `relavium run`).
  const offline = args.fixture !== undefined;
  const providers =
    args.fixture === undefined
      ? (deps.providers ?? createProviderResolver(deps.io.env))
      : cassetteResolver(loadCassette(args.fixture, deps.global.cwd));
  // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — so a one-shot live turn enforces + tracks a user-priced
  // model. SKIPPED under `--fixture`: a cassette replay must stay deterministic + fully offline (no local
  // `history.db` dependency); the recorded run already carries its costs.
  const resolvePrice = offline ? undefined : loadUserPricingOverlay(homeDir);

  // An unknown `<agent>` (path or id) throws a typed CliError here (exit 2), before any turn. The build is
  // async (2.R): it connects the agent's inline stdio `mcp_servers` (a connect failure is a fail-loud exit-2
  // CliError, cause stripped) before the one-shot turn runs. In `--fixture` (cassette) mode the run must be
  // FULLY offline: no `[[mcp_servers]]` registrations and an env-only secret resolver (never the keychain).
  const built = await (deps.buildSession ?? buildChatSession)({
    chat: config.chat,
    agentRef: args.agent,
    cwd: deps.global.cwd,
    projectConfigDir,
    now,
    uuid,
    providers,
    mcpSecretResolver: offline
      ? createMcpSecretResolver(deps.io.env)
      : (deps.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env)),
    mcpRegistrations: offline ? [] : config.mcpServers,
    ...(resolvePrice === undefined ? {} : { resolvePrice }),
    // FULLY offline in `--fixture` (cassette) mode: disable inbound MCP entirely so an agent's inline
    // `mcp_servers` are never connected (no config build, no spawn, no dial). The cassette already carries any
    // recorded tool results, so the replay needs no live MCP.
    ...(offline ? { disableMcp: true } : {}),
  });

  // Render the live stream + run the single turn + tear down — a classified turn failure maps to exit 1.
  const turnErrorCode = await runOneShotTurn(built, message, deps);
  return turnErrorCode === undefined ? EXIT_CODES.success : EXIT_CODES.workflowFailed;
}

/** Validate the one-shot invocation and read the prompt from stdin — the two pre-run faults (exit-2 CliError). */
async function resolveOneShotInput(
  args: AgentRunCommandArgs,
  deps: AgentRunCommandDeps,
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
  const message = (await readAllStdin(deps.io.stdin)).trim();
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
 * tear down — returning the classified turn-error code (or `undefined` on success). The whole post-build region
 * is inside the try so any fault still hits the finally (the session OWNS the MCP connections; teardown there is
 * best-effort and must never override the computed exit code) rather than orphaning the spawned children.
 */
async function runOneShotTurn(
  built: BuiltChatSession,
  message: string,
  deps: AgentRunCommandDeps,
): Promise<string | undefined> {
  let turnErrorCode: string | undefined;
  const renderer: (event: SessionStreamHandleEvent) => void = deps.global.json
    ? (event) => deps.io.writeOut(`${JSON.stringify(event)}\n`)
    : makePlainPrinter(deps.io);
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
      prompt: () =>
        Promise.resolve({
          outcome: 'reject',
          reason: 'interactive approval is unavailable in a one-shot agent run',
        }),
    });
    applyChatMode(modeEnv, 'ask');
    built.session.start();
    await built.session.sendMessage(message);
  } catch (err) {
    // An UNCLASSIFIED turn error re-raised by the turn core (e.g. an under-recorded `--fixture` cassette whose
    // next `stream()` call is unscripted) rejects `sendMessage`. Map it to a clean exit 1 here rather than
    // letting a raw rejection surface as an opaque boundary "internal error". The detail goes to stderr (never
    // a stack as primary output); under --json the failing `session:turn_completed.error` is already on stdout.
    turnErrorCode ??= 'internal';
    if (!deps.global.json) {
      deps.io.writeErr(`turn failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } finally {
    built.session.cancel(); // the session's terminal (session:cancelled) — closes the one-shot cleanly
    unsubscribe();
    // Tear down the MCP connections (2.R) after the one-shot turn; present only when `mcp_servers` is declared.
    // Best-effort: a teardown rejection must NOT override the computed one-shot exit code (warn, don't throw).
    await built.closeMcp?.().catch((e: unknown) => {
      deps.io.writeErr(
        `warning: MCP teardown failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    });
  }
  return turnErrorCode;
}

/** Read the whole input stream to EOF as UTF-8 text (the one-shot prompt). Exported for a focused unit test. */
export async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  // Decode binary chunks through a StringDecoder so a multi-byte UTF-8 character split ACROSS a chunk boundary
  // is buffered (not mangled into replacement chars); `decoder.end()` flushes any trailing partial sequence. A
  // test stream yields strings (a Buffer is itself a Uint8Array subclass), handled by the String fallback.
  const decoder = new StringDecoder('utf8');
  let data = '';
  for await (const chunk of stream) {
    data += chunk instanceof Uint8Array ? decoder.write(Buffer.from(chunk)) : String(chunk);
  }
  data += decoder.end();
  return data;
}
