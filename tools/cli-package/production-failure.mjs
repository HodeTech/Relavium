/**
 * What a failed package production may print (ADR-0111). A build child's captured output can quote a
 * map — esbuild excerpts a malformed upstream map in its warning — and maps are excluded from every
 * diagnostic, so that output is never printed. Only prepack's own fixed `✗ CLI …` lines, which carry
 * a code and at most a repository-relative path, and one fixed code for the failure itself remain.
 */

/** A prepack diagnostic line: its fixed prefix followed by printable ASCII only. */
const PREPACK_DIAGNOSTIC = /^✗ CLI [ -~]{1,240}$/u;
const PRINTED_DIAGNOSTICS = 8;

/**
 * The lines a failed production prints, in order: the prepack diagnostics found in the failed child's
 * captured output, then `✗ CLI package production failed: <code>`, where the code is the error's
 * leading `PACKED_CLI_*` token, else its system error code, else `UNEXPECTED`.
 * @param {unknown} error
 * @returns {string[]}
 */
export function productionFailure(error) {
  const result =
    error !== null && typeof error === 'object' && 'result' in error ? error.result : undefined;
  const captured = [result?.stdout, result?.stderr].filter((text) => typeof text === 'string');
  const diagnostics = captured
    .flatMap((text) => text.split(/\r?\n/u))
    .map((line) => line.trim())
    .filter((line) => PREPACK_DIAGNOSTIC.test(line))
    .slice(0, PRINTED_DIAGNOSTICS);
  const message = error instanceof Error ? error.message : '';
  const system =
    error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code =
    /^PACKED_CLI_[A-Z0-9_]+/u.exec(message)?.[0] ??
    (/^[A-Z][A-Z0-9_]{1,63}$/u.test(system) ? system : 'UNEXPECTED');
  return [...diagnostics, `✗ CLI package production failed: ${code}`];
}
