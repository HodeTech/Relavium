import { sanitizeInline } from '../sanitize.js';
import type { MarkdownSpan } from './types.js';
import { isWordAt, isWordBefore } from './unicode-word.js';

type Style = Omit<MarkdownSpan, 'text'>;

/** Parse the supported inline syntax into semantic spans without escape sequences. */
export function parseInline(source: string, style: Style = {}, depth = 0): MarkdownSpan[] {
  const result: MarkdownSpan[] = [];
  // Precompute forward lookup tables once per nesting level. This avoids repeated
  // searches through an unfinished suffix for every unmatched opener.
  const escaped = new Uint8Array(source.length);
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '\\' && at + 1 < source.length) {
      escaped[at + 1] = 1;
      at++;
    }
  }
  // A whole intraword underscore run is literal, including each half of `__`.
  const intraword = new Uint8Array(source.length);
  for (let at = 0; at < source.length; ) {
    if (source[at] !== '_' || escaped[at]) {
      at++;
      continue;
    }
    const start = at;
    while (source[at] === '_' && !escaped[at]) at++;
    if (isWordBefore(source, start) && isWordAt(source, at)) intraword.fill(1, start, at);
  }
  const singleRuns = new Map<string, Int32Array>();
  for (const delimiter of ['*', '_']) {
    const counts = new Int32Array(source.length + 1);
    for (let at = 0; at < source.length; at++) {
      const single =
        source[at] === delimiter &&
        source[at - 1] !== delimiter &&
        source[at + 1] !== delimiter &&
        !escaped[at];
      counts[at + 1] = (counts[at] ?? 0) + (single ? 1 : 0);
    }
    singleRuns.set(delimiter, counts);
  }
  const nextTables = new Map<string, Int32Array>();
  const next = (token: string, start: number): number => {
    let table = nextTables.get(token);
    if (!table) {
      table = new Int32Array(source.length + 1);
      let found = -1;
      for (let at = source.length; at >= 0; at--) {
        if (!escaped[at] && source.startsWith(token, at)) {
          if (!token.includes('_') || !intraword[at]) found = at;
        }
        table[at] = found;
      }
      nextTables.set(token, table);
    }
    return table[start] ?? -1;
  };
  const nextTickRun = new Map<number, number>();
  const latestTickRun = new Map<number, number>();
  for (let at = source.length - 1; at >= 0; ) {
    if (source[at] !== '`' || escaped[at]) {
      at--;
      continue;
    }
    const end = at + 1;
    while (at >= 0 && source[at] === '`' && !escaped[at]) at--;
    const start = at + 1;
    const length = end - start;
    nextTickRun.set(start, latestTickRun.get(length) ?? -1);
    latestTickRun.set(length, start);
  }
  let plain = '';
  const flush = (): void => {
    if (plain) {
      result.push({ text: plain, ...style });
      plain = '';
    }
  };
  for (let i = 0; i < source.length; ) {
    const ch = source[i] ?? '';
    if (ch === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(source[i + 1] ?? '')) {
      plain += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      if (plain.endsWith('  ')) {
        plain = plain.slice(0, -2);
        plain += '\n';
      } else if (plain.endsWith('\\')) {
        plain = plain.slice(0, -1);
        plain += '\n';
      } else plain += ' ';
      i++;
      continue;
    }
    if (ch === '`') {
      let end = i + 1;
      while (source[end] === '`') end++;
      const marker = source.slice(i, end);
      const close = nextTickRun.get(i) ?? -1;
      if (close >= 0) {
        flush();
        result.push({ text: source.slice(end, close), ...style, code: true });
        i = close + marker.length;
        continue;
      }
      plain += marker;
      i = end;
      continue;
    }
    if ((ch === '[' || (ch === '!' && source[i + 1] === '[')) && depth < 32) {
      const image = ch === '!';
      const start = i + (image ? 2 : 1);
      const close = next('](', start);
      const end = close < 0 ? -1 : next(')', close + 2);
      const nestedLabel = next('[', start);
      if (close >= 0 && end >= 0 && (nestedLabel < 0 || nestedLabel > close)) {
        const label = source.slice(start, close);
        const target = source.slice(close + 2, end);
        if (target && !/[\s()]/.test(target) && !label.includes('\n')) {
          flush();
          const safeTarget = sanitizeInline(target);
          const safeLabel = sanitizeInline(label);
          if (image)
            result.push({
              text: `[image: ${safeLabel}] (${safeTarget})`,
              ...style,
              dim: true,
              linkURL: safeTarget,
            });
          else {
            const labelSpans = parseInline(safeLabel, { ...style, linkURL: safeTarget }, depth + 1);
            for (const span of labelSpans) result.push(span);
            if (labelSpans.map((span) => span.text).join('') !== safeTarget)
              result.push({ text: ` (${safeTarget})`, ...style, linkURL: safeTarget });
          }
          i = end + 1;
          continue;
        }
        // Unsupported link syntax stays intact, including markup in its label.
        plain += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      const labelEnd = next('][', start);
      const referenceEnd = labelEnd < 0 ? -1 : next(']', labelEnd + 2);
      if (labelEnd >= 0 && referenceEnd >= 0 && (nestedLabel < 0 || nestedLabel > labelEnd)) {
        plain += source.slice(i, referenceEnd + 1);
        i = referenceEnd + 1;
        continue;
      }
    }
    if (ch === '<') {
      const end = next('>', i + 1);
      const nested = next('<', i + 1);
      const target = end < 0 || (nested >= 0 && nested < end) ? '' : source.slice(i + 1, end);
      if (/^(?:https?:\/\/[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(target)) {
        flush();
        result.push({ text: target, ...style, linkURL: target });
        i = end + 1;
        continue;
      }
    }
    if (
      depth < 31 &&
      !intraword[i] &&
      (source.startsWith('***', i) || source.startsWith('___', i))
    ) {
      const triple = source.slice(i, i + 3);
      const end = next(triple, i + 3);
      if (end > i + 3) {
        flush();
        for (const span of parseInline(
          source.slice(i + 3, end),
          { ...style, strong: true, emphasis: true },
          depth + 2,
        ))
          result.push(span);
        i = end + 3;
        continue;
      }
    }
    const marker =
      source.startsWith('**', i) || source.startsWith('__', i) || source.startsWith('~~', i)
        ? source.slice(i, i + 2)
        : ch === '*' || ch === '_'
          ? ch
          : '';
    if (marker && marker.includes('_') && intraword[i]) {
      plain += marker;
      i += marker.length;
      continue;
    }
    if (marker && depth < 32) {
      let end = next(marker, i + marker.length);
      if (
        (marker === '*' || marker === '_') &&
        end >= 0 &&
        source.startsWith(marker + marker, end)
      ) {
        const strongEnd = next(marker + marker, end + 2);
        if (strongEnd >= 0) {
          end = source[strongEnd + 2] === marker ? strongEnd + 2 : next(marker, strongEnd + 2);
        }
      } else if (
        (marker === '**' || marker === '__') &&
        end >= 0 &&
        source[end + 2] === marker[0]
      ) {
        const counts = singleRuns.get(marker[0] ?? '');
        const singles = (counts?.[end] ?? 0) - (counts?.[i + marker.length] ?? 0);
        if (singles % 2 === 1) end++;
      }
      if (end > i + marker.length) {
        flush();
        const next: Style =
          marker === '~~'
            ? { ...style, strike: true }
            : marker.length === 2
              ? { ...style, strong: true }
              : { ...style, emphasis: true };
        for (const span of parseInline(source.slice(i + marker.length, end), next, depth + 1))
          result.push(span);
        i = end + marker.length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return result;
}
