import { randomUUID } from 'node:crypto';

import type { SessionStreamHandleEvent } from '@relavium/core';

import { cassetteResolver, loadCassette } from '../chat/fixture.js';
import { buildChatSession } from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
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
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export async function agentRunCommand(
  args: AgentRunCommandArgs,
  deps: AgentRunCommandDeps,
): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const { config, projectConfigDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });

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

  // A `--fixture` replays a cassette (offline, no keychain) and takes precedence over any injected/real seam;
  // otherwise tests inject `providers`, and production resolves keys via the env/keychain (like `relavium run`).
  const providers =
    args.fixture === undefined
      ? (deps.providers ?? createProviderResolver(deps.io.env))
      : cassetteResolver(loadCassette(args.fixture, deps.global.cwd));

  // An unknown `<agent>` (path or id) throws a typed CliError here (exit 2), before any turn.
  const built = (deps.buildSession ?? buildChatSession)({
    chat: config.chat,
    agentRef: args.agent,
    cwd: deps.global.cwd,
    projectConfigDir,
    now,
    uuid,
    providers,
  });

  // Render the live stream (NDJSON under --json, else the plain token/tool printer) and capture the turn
  // outcome — a classified turn failure completes with `session:turn_completed.error`, mapping to exit 1.
  let turnErrorCode: string | undefined;
  const renderer: (event: SessionStreamHandleEvent) => void = deps.global.json
    ? (event) => deps.io.writeOut(`${JSON.stringify(event)}\n`)
    : makePlainPrinter(deps.io);
  const unsubscribe = built.handle.subscribe((event) => {
    renderer(event);
    if (event.type === 'session:turn_completed' && event.error !== undefined) {
      turnErrorCode = event.error.code;
    }
  });

  try {
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
  }
  return turnErrorCode === undefined ? EXIT_CODES.success : EXIT_CODES.workflowFailed;
}

/** Read the whole input stream to EOF as UTF-8 text (the one-shot prompt). */
async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  let data = '';
  for await (const chunk of stream) {
    // The chunk is untyped from NodeJS.ReadableStream. Decode any binary chunk (a Buffer — itself a Uint8Array
    // subclass — or a plain Uint8Array) via Buffer.from so a Uint8Array is not stringified to "104,105"; a
    // test stream yields strings, handled by the String fallback (total over `unknown`).
    data += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
  }
  return data;
}
