import { appendFileSync } from 'node:fs';
export class Entry {
  constructor() {
    appendFileSync(
      process.env.RELAVIUM_SMOKE_GUARD_LOG,
      JSON.stringify({ operation: 'keyring.Entry' }) + '\n',
      { mode: 0o600 },
    );
    throw new Error('Budget smoke offline guard: real keychain access forbidden');
  }
}
