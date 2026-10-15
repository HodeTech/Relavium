import { FilesystemMediaStore } from '@relavium/db';

const root = process.argv[2];
if (root === undefined) throw new Error('Missing synthetic CAS root');
let release = (): void => {};
const released = new Promise<void>((resolve) => {
  release = resolve;
});
process.on('message', (message: unknown) => {
  if (message === 'release') release();
});
try {
  const handle = await new FilesystemMediaStore(root).putStream(
    (async function* () {
      yield new Uint8Array([1, 2]);
      process.send?.({ stage: 'writing', pid: process.pid });
      await released;
      yield new Uint8Array([3, 4]);
    })(),
    'audio/L16',
  );
  process.send?.({ done: true, handle });
} finally {
  process.disconnect?.();
}
