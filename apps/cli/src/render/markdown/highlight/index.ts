import { languageOf, type HighlightLanguage } from './languages.js';
import { Segments, type CodeSegment } from './segments.js';

export { HIGHLIGHT_LANGUAGES, languageOf } from './languages.js';
export type { CodeSegment } from './segments.js';

/** A block longer than this is not highlighted (ADR-0144): it stays one plain code run. */
export const MAX_HIGHLIGHT_CHARS = 65_536;
/** A block with a line longer than this is not highlighted: minified or generated text. */
export const MAX_HIGHLIGHT_LINE = 4_096;

function hasLongLine(text: string): boolean {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    const stop = end < 0 ? text.length : end;
    if (stop - start > MAX_HIGHLIGHT_LINE) return true;
    start = stop + 1;
  }
  return false;
}

/**
 * Class `text` with `language`'s scanner. It throws if a scanner exceeds its step budget, which only a bug can cause;
 * {@link highlightCode} turns that into "not highlighted". Tests call this one so a bug is seen, not hidden.
 */
export function scanLanguage(text: string, language: HighlightLanguage): readonly CodeSegment[] {
  const out = new Segments(text, 8 * text.length + 256);
  language.scan(text, out);
  return out.finish();
}

/**
 * The classed runs of a fenced code block, or undefined when it is not highlighted: no info string or an unknown one,
 * an empty block, a block over the limits, or a scanner fault. The runs, joined, are exactly `text`.
 */
export function highlightCode(
  text: string,
  info: string | undefined,
): readonly CodeSegment[] | undefined {
  const language = languageOf(info);
  if (!language || text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS || hasLongLine(text))
    return undefined;
  try {
    return scanLanguage(text, language);
  } catch {
    return undefined;
  }
}
