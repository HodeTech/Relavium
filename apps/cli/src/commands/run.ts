import { relative } from 'node:path';

import {
  WorkflowParseError,
  parseWorkflow,
  type WorkflowDefinition,
  type WorkflowEngine,
} from '@relavium/core';
import type { RunEvent } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import {
  createProviderResolver,
  neededProviderIds,
  type ProviderResolver,
} from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { createJsonRenderer, createPlainRenderer } from '../render/renderer.js';
import { resolveWorkflowSource } from '../workflows/resolve.js';
import { parseInputArgs, resolveInputs } from './inputs.js';

export interface RunCommandArgs {
  readonly workflow: string;
  readonly input: readonly string[];
}

export interface RunCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable so tests (and the 2.K harness) drive a stub provider + the in-memory host. */
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  /** Injectable provider seam (key pre-flight + the engine's resolver). Defaults to the env resolver. */
  readonly providers?: ProviderResolver;
}

type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'paused';

/**
 * The `relavium run` core (2.D) — the M3 keystone and first real consumer of `@relavium/core`:
 * resolve + parse the workflow, coerce/validate `--input`, build the engine, drive its event stream
 * through a renderer, forward SIGINT as a cooperative cancel, and map the terminal outcome to a
 * deterministic exit code ([commands.md](../../../docs/reference/cli/commands.md#exit-codes)).
 * Framework-free — no commander/ink import. Pre-run faults (config / not-found / bad input / parse)
 * throw a typed {@link CliError} (exit 2); run-time outcomes arrive as events and map to 0/1/3.
 */
export async function runCommand(args: RunCommandArgs, deps: RunCommandDeps): Promise<ExitCode> {
  const build = deps.buildEngine ?? defaultBuildEngine;
  // One resolver shared by the key pre-flight and the engine, reading the CLI's env seam (io.env).
  const providers = deps.providers ?? createProviderResolver(deps.io.env);

  // Config (2.B) — a malformed layer surfaces as exit 2; the project dir powers id/slug discovery.
  const { projectConfigDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });

  const source = resolveWorkflowSource(args.workflow, { cwd: deps.global.cwd, projectConfigDir });

  let def: WorkflowDefinition;
  try {
    def = parseWorkflow(source.yaml, { source: relative(deps.global.cwd, source.path) });
  } catch (err) {
    if (err instanceof WorkflowParseError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }

  const inputs = resolveInputs(def, parseInputArgs(args.input));

  // Pre-flight provider keys: surface a missing key for an inline agent's PRIMARY provider as a clean
  // exit-2 invocation error (with the RELAVIUM_<PROVIDER>_API_KEY hint) BEFORE the engine starts, rather
  // than letting it surface mid-run as run:failed (exit 1) with the hint possibly lost. Scoped to keys
  // that are guaranteed needed (see neededProviderIds): a fallback-chain or `$ref` agent's key is
  // conditional and still surfaces at runtime, so the pre-flight never false-fails a valid run. The key
  // is read only to confirm presence here — never logged, stored, or rendered.
  for (const id of neededProviderIds(def)) {
    providers.keyFor(id);
  }

  const engine = await build({ providers });
  const handle = engine.start({ workflow: def, inputs });

  const renderer = deps.global.json ? createJsonRenderer(deps.io) : createPlainRenderer(deps.io);
  let outcome: RunOutcome | undefined;
  // Register the cancel handler immediately before the consume loop — no statement between it and the
  // `try` whose `finally` removes it, so the listener can never leak on an intervening throw.
  const onSigint = (): void => {
    handle.cancel(); // cooperative cancel → run:cancelled (idempotent, safe post-terminal)
  };
  process.once('SIGINT', onSigint);
  try {
    for await (const event of handle.events) {
      renderer.onEvent(event);
      outcome = nextOutcome(outcome, event);
      if (event.type === 'run:paused') {
        // A human gate — the only `run:paused` source in 2.D (no media-job host is wired; build-engine.ts).
        // The interactive prompt + `relavium gate` resume are 2.G (and need 2.H persistence); for 2.D the
        // run exits with the gate-paused code. When media host-wiring lands (2.S) a media-only park is also
        // a `run:paused`, so revisit whether exit 3 should distinguish it then (deferred-tasks).
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  switch (outcome) {
    case 'completed':
      return EXIT_CODES.success;
    case 'paused':
      return EXIT_CODES.gatePaused;
    default:
      // failed / cancelled / (an unreachable no-terminal) → non-zero workflow failure.
      return EXIT_CODES.workflowFailed;
  }
}

function nextOutcome(current: RunOutcome | undefined, event: RunEvent): RunOutcome | undefined {
  switch (event.type) {
    case 'run:completed':
      return 'completed';
    case 'run:failed':
      return 'failed';
    case 'run:cancelled':
      return 'cancelled';
    case 'run:paused':
      return 'paused';
    default:
      return current;
  }
}
