// CHECK sees only its own row. Temporary-table qualifiers can fail on SQLite 3.54
// RENAME; remove those identifier tokens without changing SQL literals or comments.
function quotedEnd(source, start) {
  const close = source[start] === '[' ? ']' : source[start];
  let index = start + 1;
  while (index < source.length) {
    const end = source.indexOf(close, index);
    if (end === -1) break;
    if (source[end + 1] !== close) return end + 1;
    index = end + 2;
  }
  throw new Error('Malformed generated SQL token');
}

function commentEnd(source, start) {
  if (source.startsWith('/*', start)) {
    const end = source.indexOf('*/', start + 2);
    if (end === -1) throw new Error('Malformed generated SQL token');
    return end + 2;
  }
  if (!source.startsWith('--', start)) return undefined;
  let end = start + 2;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end++;
  return end;
}

function sqlTokens(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++;
      continue;
    }
    const comment = commentEnd(source, index);
    if (comment !== undefined) {
      index = comment;
      continue;
    }
    const start = index;
    if (["'", '"', '`', '['].includes(source[index])) index = quotedEnd(source, index);
    else if (/[A-Za-z_]/.test(source[index])) {
      index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index++;
    } else index++;
    tokens.push({ value: source.slice(start, index), index: start });
  }
  return tokens;
}

export function portableRebuildChecks(source) {
  // Lex the whole source first: a CHECK-looking line inside a multiline literal is data.
  const tokens = sqlTokens(source);
  const removals = [];
  const identifier = (token) => {
    if (token === undefined) return undefined;
    if (token.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
    if (token.startsWith('`')) return token.slice(1, -1).replaceAll('``', '`');
    if (token.startsWith('[')) return token.slice(1, -1).replaceAll(']]', ']');
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(token) ? token : undefined;
  };
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value.toUpperCase() !== 'CHECK' || tokens[index + 1]?.value !== '(') continue;
    let depth = 1;
    let end = index + 2;
    for (; end < tokens.length && depth > 0; end++) {
      const token = tokens[end].value;
      if (token === '(') depth++;
      else if (token === ')') depth--;
      else if (
        identifier(token)?.startsWith('__new_') === true &&
        tokens[end + 1]?.value === '.' &&
        identifier(tokens[end + 2]?.value) !== undefined
      ) {
        // Keep intervening whitespace/comments byte-identical; delete only qualifier and dot.
        for (const part of [tokens[end], tokens[end + 1]])
          removals.push([part.index, part.index + part.value.length]);
      }
    }
    if (depth !== 0) throw new Error('Malformed generated CHECK expression');
    index = end - 1;
  }
  let cursor = 0;
  const pieces = [];
  for (const [start, end] of removals) {
    pieces.push(source.slice(cursor, start));
    cursor = end;
  }
  pieces.push(source.slice(cursor));
  return pieces.join('');
}
