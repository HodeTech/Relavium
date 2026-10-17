import { record } from './guard-log.mjs';
export class Entry {
  constructor(service, account) {
    record({ operation: 'keyring.Entry', service, account, denied: true });
    throw new Error('Synthetic package smoke refuses real keyring API');
  }
}
