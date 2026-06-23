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
import { createCliHost } from '../engine/host.js';
import {
  createProviderResolver,
  neededProviderIds,
  type ProviderResolver,
} from '../engine/providers.js';
import type { OpenedHistory } from '../history/open.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
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
  /**
   * Production wires the durable SQLite run-history store (2.H) here, per workflow; the unit tests and the
   * 2.K harness omit it, keeping the in-memory `RunStore` so they never open `~/.relavium/history.db`.
   */
  readonly openRunStore?: (workflow: WorkflowDefinition, homeDir: string) => OpenedHistory;
  /**
   * Injectable renderer selector (TUI / json / plain). Defaults to the real {@link selectRenderer}; tests
   * inject a fake renderer (onEvent + finalize spies) to assert the finalize wiring without a TTY.
   */
  readonly selectRenderer?: (io: CliIo, global: GlobalOptions) => RunRenderer;
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

  // Config (2.B) — a malformed layer surfaces as exit 2; the project dir powers id/slug discovery,
  // homeDir locates `~/.relavium/history.db` (2.H).
  const { projectConfigDir, homeDir } = loadResolvedConfig({
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

  // Durable history (2.H): open `~/.relavium/history.db` and run THIS workflow on a host backed by the
  // SQLite `RunStore`, so every node-boundary/terminal event is persisted before delivery (ADR-0036). Tests
  // and the 2.K harness omit `openRunStore` → the in-memory default host, no DB touched. `close()` releases
  // the connection at run end. A persist failure rejects out of the engine (ADR-0050 fatal posture).
  let opened: OpenedHistory | undefined;
  try {
    opened = deps.openRunStore?.(def, homeDir);
  } catch (err) {
    // A pre-run history fault (cannot create / open / migrate ~/.relavium/history.db) is an INVOCATION
    // fault (exit 2), not a workflow failure (exit 1) — surface it as such, before the engine starts, so a
    // `--json`/CI consumer can tell "the history db couldn't open" from "a node failed mid-run".
    throw new CliError(
      'invalid_invocation',
      `could not open the run history database: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  try {
    const engine = await build(
      opened === undefined ? { providers } : { providers, host: createCliHost(opened.store) },
    );
    const handle = engine.start({ workflow: def, inputs });

    let outcome: RunOutcome | undefined;
    let cancelRequested = false;
    // Register the cancel handler the instant the engine is live — BEFORE constructing the renderer — so a
    // failure building the renderer (e.g. ink's `render()` throwing) can never leave a running engine with no
    // cooperative-cancel handler; a Ctrl-C in that window still routes to handle.cancel(). The `finally`
    // removes it, so the listener can't leak on a throw.
    const onSigint = (): void => {
      if (cancelRequested) {
        // A second Ctrl-C while the cooperative cancel is still draining — force a clean, deterministic exit
        // rather than hang (e.g. if a provider ignores the abort), and never the bare-signal 130.
        process.exit(EXIT_CODES.workflowFailed);
      }
      cancelRequested = true;
      handle.cancel(); // cooperative cancel → run:cancelled (idempotent, safe post-terminal)
    };
    // `process.on`, NOT `process.once`: an interactive run mounts ink, which registers a `signal-exit` SIGINT
    // listener that RE-RAISES SIGINT (→ 128+2 = exit 130) BUT ONLY when it is the sole remaining SIGINT
    // listener. A `once` handler removes itself the instant it fires, so signal-exit then sees only itself and
    // re-raises — killing the run at 130 before the cooperative cancel completes. Staying registered keeps
    // signal-exit from re-raising, so cancel → run:cancelled → exit 1 wins. Removed in the `finally`.
    process.on('SIGINT', onSigint);
    let renderer: RunRenderer | undefined;
    try {
      // Output mode (commands.md "Output modes"): the ink TUI on an interactive TTY, NDJSON under --json,
      // the plain line renderer otherwise — all the same `onEvent` seam over one bus (2.F / 2.K).
      renderer = (deps.selectRenderer ?? selectRenderer)(deps.io, deps.global);
      for await (const event of handle.events) {
        renderer.onEvent(event);
        outcome = nextOutcome(outcome, event);
        if (event.type === 'run:paused') {
          // A human gate — the only `run:paused` source in 2.D (no media-job host is wired; build-engine.ts).
          // The interactive prompt + `relavium gate` resume are 2.G (the persisted gate state is now durable,
          // 2.H); for now the run exits with the gate-paused code. When media host-wiring lands (2.S) a
          // media-only park is also a `run:paused`, so revisit whether exit 3 should distinguish it then.
          break;
        }
      }
    } finally {
      // No terminal/paused outcome means we're unwinding abnormally (renderer construction threw, or the
      // event stream rejected) — cancel the still-live engine run so it doesn't keep executing unsupervised
      // in the background while the error propagates (cancel is idempotent + safe post-terminal).
      if (outcome === undefined) {
        handle.cancel();
      }
      // Tear the renderer down even on a throw: the ink TUI must unmount to restore the terminal and write
      // its persistent final summary. The `?.` is a no-op for the line/NDJSON renderers and when `renderer`
      // is still undefined (construction threw). A teardown error must NOT mask the run's real
      // outcome/error — surface it to stderr and move on.
      try {
        await renderer?.finalize?.();
      } catch (teardownErr) {
        deps.io.writeErr(
          `renderer teardown failed: ${teardownErr instanceof Error ? teardownErr.message : String(teardownErr)}\n`,
        );
      }
      // Remove our SIGINT handler LAST — keep it registered across ink's unmount (renderer.finalize), so a
      // Ctrl-C during unmount still hits us (forcing a clean exit 1) and ink's `signal-exit` never becomes the
      // sole SIGINT listener (which would re-raise → 130). After finalize, ink has unsubscribed its own
      // listener, so removing ours here leaves the SIGINT set clean.
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
  } finally {
    opened?.close();
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
