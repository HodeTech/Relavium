/** The custody tools' one refusal (Step 9b.1): a fixed code, never a path, key, map byte or child output. */
export class CustodyError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`PACKED_CLI_CUSTODY_${code}`);
    this.name = 'CustodyError';
    this.code = code;
  }
}

/** @param {string} code @returns {never} */
export function refuseCustody(code) {
  throw new CustodyError(code);
}
