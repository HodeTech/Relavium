/** A recognized link construct, as a UTF-16 half-open range. */
export interface OpaqueTarget {
  readonly start: number;
  readonly end: number;
  readonly bare?: boolean;
}

const invalidLinkTargetCharacter = /[\s()]/u;

/** Characters excluded by the supported inline link-target grammar. */
export function isInvalidLinkTargetCharacter(character: string): boolean {
  return invalidLinkTargetCharacter.test(character);
}

/** Whole-target equivalent used when a complete candidate is already buffered. */
export function isValidLinkTarget(target: string): boolean {
  return target.length > 0 && !invalidLinkTargetCharacter.test(target);
}

/** Autolinks are deliberately restricted to the documented HTTP(S) and email forms. */
export function isAutolinkTarget(target: string): boolean {
  const start = target.startsWith('https://') ? 8 : target.startsWith('http://') ? 7 : 0;
  let at = -1;
  let domainDot = false;
  // Do not use competing repetitions around the email's dot: a long dotted
  // domain ending in a second @ otherwise backtracks quadratically on rejection.
  for (let position = start; position < target.length; position++) {
    const character = target[position] ?? '';
    if (/[\s<>]/u.test(character)) return false;
    if (start) continue;
    if (character === '@') {
      if (at >= 0 || position === 0) return false;
      at = position;
    } else if (character === '.' && at >= 0 && position > at + 1 && position < target.length - 1)
      domainDot = true;
  }
  return start ? target.length > start : at > 0 && domainDot;
}

/** Find complete links and literal unsupported links in linear time. */
export function findOpaqueTargets(source: string): readonly OpaqueTarget[] {
  const escaped = new Uint8Array(source.length);
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '\\' && at + 1 < source.length) escaped[at + 1] = 1;
    if (source[at] === '\\' && at + 1 < source.length) at++;
  }
  const parens = new Int32Array(source.length);
  parens.fill(-1);
  const openParens: number[] = [];
  for (let at = 0; at < source.length; at++) {
    if (escaped[at]) continue;
    if (source[at] === '(') openParens.push(at);
    else if (source[at] === ')') {
      const open = openParens.pop();
      if (open !== undefined) parens[open] = at;
    }
  }
  const indices = new Map<string, Int32Array>();
  const next = (token: string, start: number): number => {
    let table = indices.get(token);
    if (!table) {
      table = new Int32Array(source.length + 1);
      let found = -1;
      for (let at = source.length; at >= 0; at--) {
        if (!escaped[at] && source.startsWith(token, at)) found = at;
        table[at] = found;
      }
      indices.set(token, table);
    }
    return table[start] ?? -1;
  };
  const ranges: OpaqueTarget[] = [];
  for (let at = 0; at < source.length; at++) {
    if (escaped[at]) continue;
    if (source[at] === '[') {
      const close = next('](', at + 1);
      const end = close < 0 ? -1 : (parens[close + 1] ?? -1);
      const nested = next('[', at + 1);
      if (close >= 0 && end >= 0 && (nested < 0 || nested > close)) {
        ranges.push({ start: at, end: end + 1 });
        at = end;
      } else {
        const labelEnd = next('][', at + 1);
        const referenceEnd = labelEnd < 0 ? -1 : next(']', labelEnd + 2);
        if (labelEnd >= 0 && referenceEnd >= 0 && (nested < 0 || nested > labelEnd)) {
          ranges.push({ start: at, end: referenceEnd + 1 });
          at = referenceEnd;
        } else {
          // A complete bare group is an unsupported shortcut-reference
          // candidate. Its label stays opaque even if a later chunk starts
          // an inline/reference suffix; a completed construct extends it.
          const bareEnd = next(']', at + 1);
          if (bareEnd >= 0 && (nested < 0 || nested > bareEnd)) {
            const significant = ['\\', '\n', '`', '[', '!', '<', '*', '_', '~'].some((token) => {
              const position = next(token, at + 1);
              return position >= 0 && position < bareEnd;
            });
            if (significant) ranges.push({ start: at, end: bareEnd + 1, bare: true });
            at = bareEnd;
          }
        }
      }
    } else if (source[at] === '<') {
      const end = next('>', at + 1);
      const nested = next('<', at + 1);
      if (end >= 0 && (nested < 0 || nested > end) && isAutolinkTarget(source.slice(at + 1, end))) {
        ranges.push({ start: at, end: end + 1 });
        at = end;
      }
    }
  }
  return ranges;
}
