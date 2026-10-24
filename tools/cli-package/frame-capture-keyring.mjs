// The keyring binding seen by the symbolication run (frame-capture-hooks.mjs): every export of the
// real package is present, and every use refuses, so no native binding loads and no secret is read.
const refused = () => {
  throw new Error('The symbolication run refuses the keyring');
};
export class Entry {
  constructor() {
    refused();
  }
}
export class AsyncEntry extends Entry {}
export class EntryTask extends Entry {}
export class SecretTask extends Entry {}
export class PasswordTask extends Entry {}
export class FindCredentials extends Entry {}
export const findCredentials = refused;
export const findCredentialsAsync = refused;
