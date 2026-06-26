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
 * `echo … | relavium agent run` idiom); `--input k=v` pairs populate the session's `{{ctx.*}}` variables;
 * `--fixture <path>` replays a recorded cassette so the run is deterministic + offline. `--json` emits the
 * NDJSON `session:*` stream; otherwise the assistant reply streams in human form. Unlike the REPL it is NOT
 * persisted (a stateless invoke). Exit: the turn's outcome — `0` on success, `1` on a turn error; an
 * invocation fault (no message / unknown agent / bad `--input` / bad cassette) is `2`.
 */

export interface AgentRunCommandArgs {
  /** `<agent>` (required) — a `.agent.yaml` path or a `.relavium/` agent id. */
  readonly agent: string;
  /** `--input k=v` (repeatable) — session `{{ctx.*}}` variables (plaintext, no secrets). */
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

  // The one-shot prompt is the piped stdin; an empty stdin is a clean invocation fault (nothing to run).
  const message = (await readAllStdin(deps.io.stdin)).trim();
  if (message.length === 0) {
    throw new CliError(
      'invalid_invocation',
      'no input message — pipe the prompt on stdin (e.g. `echo "…" | relavium agent run <agent>`)',
    );
  }
  const variables = parseInputVariables(args.input);

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
    ...(Object.keys(variables).length === 0 ? {} : { variables }),
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
  } finally {
    built.session.cancel(); // the session's terminal (session:cancelled) — closes the one-shot cleanly
    unsubscribe();
  }
  return turnErrorCode === undefined ? EXIT_CODES.success : EXIT_CODES.workflowFailed;
}

/** Read the whole input stream to EOF as UTF-8 text (the one-shot prompt). Stream chunks are `any`-typed. */
async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  let data = '';
  for await (const chunk of stream) {
    // `Buffer.isBuffer` narrows the any-typed chunk to Buffer (production stdin); a test stream yields strings.
    data += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return data;
}

/**
 * Parse repeatable `--input k=v` into the `{{ctx.*}}` variable map. The first `=` splits key/value (so a value
 * may contain `=`); a missing `=`, an empty key, or a duplicate key is a clean exit-2 invocation fault.
 */
function parseInputVariables(pairs: readonly string[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError('invalid_invocation', `invalid --input '${pair}' — expected key=value`);
    }
    const key = pair.slice(0, eq);
    if (key in variables) {
      throw new CliError('invalid_invocation', `duplicate --input key '${key}'`);
    }
    variables[key] = pair.slice(eq + 1);
  }
  return variables;
}
