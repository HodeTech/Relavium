// The keyring binding seen by the symbolication run (frame-capture-hooks.mjs): every use refuses.
export class Entry {
  constructor() {
    throw new Error('The symbolication run refuses the keyring');
  }
}
