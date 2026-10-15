import { CliError } from '../process/errors.js';

/**
 * Shared first-run/resume secret transport (ADR-0107): trim names, preserve values after the first
 * equals sign, and remove a carriage return at the end of a line. The caller supplies a fixed command context,
 * never stdin data, and separately admits names against the workflow's declared secret slots.
 */
export function parseSecretLines(raw: string, context: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of raw.split('\n')) {
    const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (stripped.trim() === '') continue;
    const at = stripped.indexOf('=');
    const name = at === -1 ? '' : stripped.slice(0, at).trim();
    const value = at === -1 ? '' : stripped.slice(at + 1);
    if (name === '' || value.trim() === '') {
      throw new CliError(
        'invalid_invocation',
        `stdin for ${context} must be \`name=value\` lines with a non-empty value.`,
      );
    }
    if (Object.hasOwn(out, name)) {
      throw new CliError(
        'invalid_invocation',
        `stdin for ${context} supplied the same \`secret\` name twice.`,
      );
    }
    out[name] = value;
  }
  return out;
}
