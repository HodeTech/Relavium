/**
 * Strict Source Map v3 `mappings` decoding for the candidate finalizer and symbolication (ADR-0111,
 * Step 9a.2a). Node's built-in `node:module` SourceMap is lenient — it decodes an invalid character as
 * zero and extrapolates a position it has no segment for — so it serves only as an independent test
 * oracle, never as the validator. A refusal names a fixed code and never quotes the mappings.
 */

export class SourceMapError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`source map refused: ${code}`);
    this.name = 'SourceMapError';
    this.code = code;
  }
}

/** @param {string} code @returns {never} */
function refuse(code) {
  throw new SourceMapError(code);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) DIGITS[BASE64.charCodeAt(index)] = index;
/** The largest unsigned VLQ value (a signed 32-bit magnitude and its sign bit). */
const VLQ_MAX = 0xffffffff;

/**
 * One decoded segment: a generated column, and for a mapped segment its source index and 0-based
 * original line and column, and optionally a name index.
 * @typedef {{generatedColumn: number, source?: number, originalLine?: number,
 *   originalColumn?: number, name?: number}} Segment
 */

/**
 * Decode `mappings` into one array of segments per generated line. Refuses a character outside the
 * base64 alphabet, a truncated or oversized value, an empty segment, a segment of other than 1, 4 or 5
 * fields, a generated column that does not increase along its line, and a negative or out-of-range
 * source, name, line or column.
 * @param {string} mappings
 * @param {{sources: number, names: number}} counts the lengths of the map's `sources` and `names`
 * @returns {Segment[][]}
 */
export function decodeMappings(mappings, { sources, names }) {
  if (typeof mappings !== 'string') refuse('MAPPINGS_TYPE');
  /** @type {Segment[][]} */
  const lines = [[]];
  let column = 0;
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  /** @type {number[]} */
  let fields = [];
  let position = 0;
  const finish = () => {
    if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5)
      refuse('MAPPINGS_FIELDS');
    const line = lines[lines.length - 1];
    column += fields[0];
    if (column < 0) refuse('MAPPINGS_RANGE');
    if (line.length > 0 && column <= line[line.length - 1].generatedColumn)
      refuse('MAPPINGS_ORDER');
    /** @type {Segment} */
    const segment = { generatedColumn: column };
    if (fields.length >= 4) {
      source += fields[1];
      originalLine += fields[2];
      originalColumn += fields[3];
      if (source < 0 || source >= sources || originalLine < 0 || originalColumn < 0) {
        refuse('MAPPINGS_RANGE');
      }
      segment.source = source;
      segment.originalLine = originalLine;
      segment.originalColumn = originalColumn;
      if (fields.length === 5) {
        name += fields[4];
        if (name < 0 || name >= names) refuse('MAPPINGS_RANGE');
        segment.name = name;
      }
    }
    line.push(segment);
    fields = [];
  };
  while (position < mappings.length) {
    const character = mappings.charCodeAt(position);
    if (character === 0x3b /* ; */ || character === 0x2c /* , */) {
      // An empty segment is malformed; an empty line is not.
      if (fields.length > 0) finish();
      else if (character === 0x2c || mappings.charCodeAt(position - 1) === 0x2c) {
        refuse('MAPPINGS_EMPTY_SEGMENT');
      }
      if (character === 0x3b) {
        lines.push([]);
        column = 0;
      }
      position += 1;
      continue;
    }
    let value = 0;
    let scale = 1;
    for (;;) {
      if (position >= mappings.length) refuse('MAPPINGS_TRUNCATED');
      const code = mappings.charCodeAt(position);
      const digit = code < 128 ? DIGITS[code] : -1;
      if (digit < 0) refuse('MAPPINGS_CHARACTER');
      position += 1;
      value += (digit & 31) * scale;
      if (value > VLQ_MAX) refuse('MAPPINGS_RANGE');
      if ((digit & 32) === 0) break;
      scale *= 32;
    }
    const magnitude = Math.floor(value / 2);
    fields.push(value % 2 === 1 ? -magnitude : magnitude);
  }
  if (fields.length > 0) finish();
  else if (mappings.charCodeAt(mappings.length - 1) === 0x2c) refuse('MAPPINGS_EMPTY_SEGMENT');
  return lines;
}

/**
 * The segment that starts exactly at a 0-based generated position, or `undefined`. Never the
 * nearest preceding one: a frame that is off by a column must not map.
 * @param {Segment[][]} lines @param {number} line @param {number} column
 */
export function segmentAt(lines, line, column) {
  const segments = lines[line];
  if (segments === undefined) return undefined;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = segments[middle].generatedColumn;
    if (start === column) return segments[middle];
    if (start < column) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

/** The line terminators ECMAScript and TypeScript both count. */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/u;

/**
 * The UTF-16 length of each line of `text`, as V8 and TypeScript count lines and columns.
 * @param {string} text
 */
export function lineLengths(text) {
  return text.split(LINE_TERMINATOR).map((line) => line.length);
}

/**
 * Require every generated position to lie inside the generated text: no segment on a line the text
 * does not have, and no segment past its line's end (a position at the end is a caret position, as
 * esbuild maps an empty line at column 0).
 * @param {Segment[][]} lines @param {number[]} generated the generated text's line lengths
 */
export function assertGeneratedRange(lines, generated) {
  for (let line = 0; line < lines.length; line += 1) {
    const segments = lines[line];
    if (segments.length === 0) continue;
    if (line >= generated.length) refuse('GENERATED_RANGE');
    if (segments[segments.length - 1].generatedColumn > generated[line]) refuse('GENERATED_RANGE');
  }
}

/**
 * Require every original position to lie inside its source text: an existing line, and a column no
 * further than that line's end.
 * @param {Segment[][]} lines @param {readonly number[][]} originals line lengths per source index
 */
export function assertOriginalRange(lines, originals) {
  for (const segments of lines) {
    for (const segment of segments) {
      if (segment.source === undefined) continue;
      const lengths = originals[segment.source];
      const length = lengths?.[segment.originalLine ?? -1];
      if (length === undefined || (segment.originalColumn ?? 0) > length) refuse('ORIGINAL_RANGE');
    }
  }
}
