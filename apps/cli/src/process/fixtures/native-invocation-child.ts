/** Synthetic fault injection around the actual inert native coordinator; no product activation claim. */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { createClient } from '@relavium/db';
import { InvocationRegistry, type OwnerRetirement } from '../invocation-registry.js';
import { installNativeInvocation } from '../native-invocation.js';
import { acknowledgeWrite } from '../io.js';

const mode = process.argv[2];
const root = process.argv[3];
if (root === undefined) throw new Error('fixture requires owned scratch');
const registry = new InvocationRegistry({
  now: () => performance.now(),
  schedule: (milliseconds, fire) => {
    const timer = setTimeout(fire, milliseconds);
    return () => clearTimeout(timer);
  },
});
const native = installNativeInvocation(registry, { json: true, verbosity: 'verbose' });
let startedAt = 0;
let stops = 0;
let restored = false;
let sqlite: ReturnType<typeof createClient>['sqlite'] | undefined;
const keepalive = setInterval(() => undefined, 1000);
process.on('exit', () => {
  writeFileSync(
    join(root, 'exit.json'),
    JSON.stringify({
      elapsed: performance.now() - startedAt,
      activeOwners: registry.activeOwners,
      stops,
      restored,
      dbOpen: sqlite?.open,
      deadline: registry.budget.deadline(),
    }),
  );
});

if (mode === 'autonomous-db') {
  sqlite = createClient(join(root, 'owned.sqlite')).sqlite;
  sqlite.exec('CREATE TABLE fixture (value INTEGER)');
  const retired = new Promise<OwnerRetirement>(() => undefined);
  const lease = registry.register({
    kind: 'session',
    surface: 'chat',
    retired,
    stop: () => {
      stops++;
    },
    // Synthetic join fault: actual DB remains owned by the unresolved session lifetime.
    join: () => {
      throw new Error('synthetic opaque owner join fault');
    },
    classifyFailure: () => 'cli_internal',
  });
  process.on('message', () => {
    startedAt = performance.now();
    void lease.close();
  });
} else if (mode === 'held-ack') {
  let retire: (value: OwnerRetirement) => void = () => undefined;
  const retired = new Promise<OwnerRetirement>((resolve) => {
    retire = resolve;
  });
  registry.register({
    kind: 'session',
    surface: 'chat',
    retired,
    stop: () => {
      stops++;
    },
    join: () => undefined,
    classifyFailure: () => 'cli_internal',
  });
  // Honest synthetic ACK hold: real stderr bytes are sent; only callback delivery is withheld.
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  ) => {
    if (typeof encodingOrCallback === 'string')
      return write(chunk, encodingOrCallback, () => undefined);
    return write(chunk, () => undefined);
  };
  process.on('message', () => {
    startedAt = performance.now();
    native.fail('cli_internal');
    setTimeout(() => retire({ kind: 'settled' }), 1200);
  });
} else if (mode === 'restoration') {
  let retire: (value: OwnerRetirement) => void = () => undefined;
  const retired = new Promise<OwnerRetirement>((resolve) => {
    retire = resolve;
  });
  registry.register({
    kind: 'terminal',
    retired,
    stop: () => {
      stops++;
    },
    join: () => undefined,
    restore: async () => {
      // Native fixture custody witness, not an Ink/raw-mode integration claim.
      await acknowledgeWrite(process.stderr, '\u001b[?25h\u001b[?1049l');
      restored = true;
      retire({ kind: 'settled' });
    },
    classifyFailure: () => 'cli_internal',
  });
  process.on('message', () => {
    startedAt = performance.now();
    native.fail('cli_internal');
    native.fail('cli_internal');
  });
} else if (mode === 'stdout-pipe' || mode === 'stderr-pipe') {
  process.on('message', () => {
    startedAt = performance.now();
    const stream = mode === 'stdout-pipe' ? process.stdout : process.stderr;
    // An actual native pipe write after the parent closes its reader produces EPIPE.
    stream.write('synthetic native pipe probe\n');
  });
} else if (mode === 'fatal-opaque') {
  process.on('message', () => {
    startedAt = performance.now();
    const touched = () => {
      writeFileSync(join(root, 'getter-touched'), 'bad');
      throw new Error('synthetic secret getter');
    };
    const reason = Object.defineProperties(new Error(), {
      message: { get: touched },
      stack: { get: touched },
      cause: { get: touched },
      toString: { get: touched },
      [Symbol.toPrimitive]: { get: touched },
    });
    setImmediate(() => {
      throw reason;
    });
  });
} else {
  clearInterval(keepalive);
  native.dispose();
  throw new Error('unknown fixture mode');
}
process.send?.({ type: 'ready' });
// This main never completes: native observation, rather than top-level await settlement, must exit.
await new Promise<void>(() => undefined);
