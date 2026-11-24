import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hintLiterals } from './hint-shape.js';

/** `apps/cli/src`, with a trailing separator. */
export const CLI_SRC = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The text of the one hint-shaped string literal of `file` (relative to `apps/cli/src`) that contains `needle`, with an interpolation
 * written `${…}`: the **fallback** for a string that is written inline in a host too large to mount for its sake (an overlay's footer
 * prop, say). It records what the source says, not what a frame draws, so a recorder uses it only where the string is passed on whole.
 * It throws when the needle matches none or more than one literal, so the recording cannot silently follow a different string.
 */
export function sourceLiteral(file: string, needle: string): string {
  const found = hintLiterals(readFileSync(`${CLI_SRC}${file}`, 'utf8'), file).filter((literal) =>
    literal.text.includes(needle),
  );
  if (found.length !== 1) {
    throw new Error(
      `${file}: expected exactly one hint-shaped literal containing ${JSON.stringify(needle)}, found ${String(found.length)}`,
    );
  }
  return found[0]?.text ?? '';
}
