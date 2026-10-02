// Real-process session key coexistence smoke. Only an owned test database and built package are used.
/* global process */
const [, , distUrl, dbPath] = process.argv;
let client;
try {
  // eslint-disable-next-line no-restricted-syntax -- real child cannot use Vitest's TS source resolution
  const { createClient, createSessionStore } = await import(distUrl);
  client = createClient(dbPath);
  const store = createSessionStore(client.db);
  process.stdout.write('READY\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  const keys = Array.from({ length: 100 }, () => store.reserveEffectTurnKey('s1'));
  process.stdout.write(JSON.stringify(keys) + '\n');
} finally {
  process.stdin.destroy();
  client?.sqlite.close();
}
