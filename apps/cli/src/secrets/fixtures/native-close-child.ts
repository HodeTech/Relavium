/** Actual consumed stdin pipe; parent owns release of its native close delivery. Synthetic data only. */
import { CommandLifetime } from '../../process/command-lifetime.js';
import { createCliInvocation } from '../../process/invocation.js';
import { toUserFacing } from '../../process/errors.js';
import { captureIo } from '../../test-support.js';
import { readSecretFromStdin } from '../read-secret.js';
import { agentRunCommand } from '../../commands/agent-run.js';
import { join } from 'node:path';

const mode = process.argv[2];
if (
  ![
    'factory',
    'cap',
    'cancel',
    'predestroyed',
    'agent-eof',
    'agent-factory',
    'agent-cancel',
    'agent-predestroyed',
  ].includes(mode ?? '')
)
  throw new Error('Fixture mode required.');
const agent = mode?.startsWith('agent-') === true;
const action = agent ? mode?.slice('agent-'.length) : mode;
const root = process.argv[3];
if (agent && root === undefined) throw new Error('Isolated agent fixture root required.');
const input = process.stdin;
let releaseClose: (() => void) | undefined;
let enteredClose: () => void = () => {};
const heldClose = new Promise<void>((resolve) => {
  enteredClose = resolve;
});
let delivered = false,
  settled = false,
  cleaned = false;
let result: { code?: string; exitCode?: number; returned?: number } | undefined;
const originalEmit = input.emit.bind(input);
input.emit = (event: string | symbol, ...args: unknown[]): boolean => {
  if (event === 'close') {
    releaseClose = () => {
      delivered = true;
      Reflect.apply(originalEmit, input, [event, ...args]);
    };
    enteredClose();
    return true;
  }
  const emitted: unknown = Reflect.apply(originalEmit, input, [event, ...args]);
  if (typeof emitted !== 'boolean') throw new Error('Unexpected native event result.');
  return emitted;
};
input.on('error', () => {});
const snapshot = () => ({
  mode,
  delivered,
  settled,
  cleaned,
  closed: input.closed,
  activeOwners: invocation.registry.activeOwners,
  result,
});
const invocation = createCliInvocation({
  exit: (code) => {
    process.stdout.write(JSON.stringify({ phase: 'physical-exit', code, ...snapshot() }) + '\n');
    process.exit(code);
  },
  setExitCode: () => {},
});
const io = { ...captureIo().io, stdin: input };
const owner = agent ? undefined : new CommandLifetime(invocation, io, () => () => {});
owner?.adoptCleanup(() => {
  cleaned = true;
});
process.on('message', (message: unknown) => {
  if (message === 'release') releaseClose?.();
});
if (action === 'predestroyed') {
  input.destroy();
  await heldClose;
}
if (action === 'factory')
  input[Symbol.asyncIterator] = () => {
    throw new Error('synthetic native iterator factory refusal');
  };
const operation =
  agent && root !== undefined
    ? agentRunCommand(
        {
          agent: 'synthetic',
          fixture: join(root, 'absent-synthetic-cassette.json'),
          input: [],
          allowMcpStdio: [],
        },
        {
          invocation,
          io,
          global: {
            cwd: root,
            configPath: join(root, 'config.toml'),
            json: false,
            color: false,
            verbosity: 'normal',
          },
        },
      )
    : owner?.execute(async () => {
        await readSecretFromStdin(undefined, input, {
          signal: owner.work.signal,
          onFailure: owner.work.failure,
        });
        return 0;
      });
if (operation === undefined) throw new Error('Fixture owner required.');
const reading = operation.then(
  (returned) => {
    settled = true;
    result = { returned };
  },
  (cause: unknown) => {
    settled = true;
    const facing = toUserFacing(cause);
    result = { code: facing.code, exitCode: facing.exitCode };
  },
);
if (action === 'cancel') invocation.finiteExit.signal(15);
await heldClose;
// Flush promise continuations: public Socket.closed may already be true while delivery stays held.
await new Promise<void>((resolve) => setImmediate(resolve));
process.send?.({ phase: 'held', ...snapshot() });
await reading;
// Signal mode specifically owes the actual finite-exit port, not an IPC/natural-exit race.
if (action === 'cancel' || (agent && action === 'factory')) await new Promise<never>(() => {});
process.send?.({ phase: 'settled', ...snapshot() }, () => process.disconnect());
