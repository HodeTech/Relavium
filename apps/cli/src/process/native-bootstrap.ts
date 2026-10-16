import { resolveDiagnosticPolicy, type DiagnosticPolicy } from './diagnostic-policy.js';
import type { CliIo } from './io.js';
import { createCliInvocation, type CliInvocation } from './invocation.js';
import type { OwnerRetirement } from './invocation-registry.js';
import {
  installNativeInvocation,
  type NativeInvocation,
  type NativeInvocationPorts,
} from './native-invocation.js';
import { extractGlobalOptions } from './options.js';
import { defaultSubscribeSignals } from './signals.js';
import { projectCliError } from './cli-error.js';

type Runtime = Pick<typeof import('../run.js'), 'run'>;

/** One native observer/exit authority exists before the first guarded runtime import. */
export function startNativeCli(
  argv: readonly string[],
  io: CliIo,
  invocation: CliInvocation = createCliInvocation(),
  ports?: NativeInvocationPorts,
  load: () => Promise<Runtime> = () => import('../run.js'),
  subscribeSignals = defaultSubscribeSignals,
): NativeInvocation {
  const { raw } = extractGlobalOptions(argv);
  let policy: DiagnosticPolicy;
  try {
    policy = resolveDiagnosticPolicy(raw, io.env);
  } catch {
    // run owns the typed flag refusal. A failing runtime import still needs the captured JSON sink.
    policy = { json: raw.json === true, verbosity: 'normal' };
  }
  let retire: (fact: OwnerRetirement) => void = () => undefined;
  const retired = new Promise<OwnerRetirement>((resolve) => {
    retire = resolve;
  });
  invocation.registry.register({
    kind: 'command',
    retired,
    stop: () => undefined, // Registry sealing prevents late imports from entering runtime work.
    join: () => retired.then(() => undefined),
    classifyFailure: () => 'cli_internal',
  });
  const native = installNativeInvocation(invocation.registry, policy, ports, invocation.finiteExit);
  let removeSignals = (): void => undefined;
  try {
    removeSignals = subscribeSignals((signo) => {
      if (invocation.signalCustody?.claimed !== true) invocation.finiteExit.signal(signo);
    });
  } catch {
    native.fail('cli_internal');
  }

  const execute = async (): Promise<void> => {
    try {
      if (invocation.registry.termination !== undefined) return;
      const runtime = await load();
      if (invocation.registry.termination !== undefined) return;
      const code = await runtime.run(argv, io, undefined, invocation, native);
      switch (code) {
        case 0:
        case 1:
        case 2:
        case 3:
        case 4:
        case 6:
          invocation.registry.observations.observeOutcome(code);
          break;
        case 5:
        case 7:
        case 8: {
          // A returned number grants no receipt/effect authority. The actual workflow owner supplies it.
          invocation.registry.sampleWorkflowHealth();
          const actual = invocation.registry.observations.exitCode();
          if (actual !== 5 && actual !== 7 && actual !== 8) native.fail('cli_internal');
          break;
        }
        case 9:
          if (
            !invocation.registry.observations.hasInfrastructureFailure() &&
            invocation.registry.observations.exitCode() !== 9
          )
            native.fail('cli_internal');
          break;
        default:
          native.fail('cli_internal');
      }
    } catch (cause) {
      native.fail(
        projectCliError(cause)?.code === 'output_unavailable'
          ? 'output_unavailable'
          : 'cli_internal',
      );
    } finally {
      // Actual loader/run settlement precedes finalization: awaiting shutdown here would join ourselves.
      retire({ kind: 'settled' });
      void native.complete();
    }
  };
  void execute().catch(() => native.fail('cli_internal'));
  return Object.freeze({
    ...native,
    dispose: () => {
      removeSignals();
      native.dispose();
    },
  });
}
