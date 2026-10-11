// CHECK sees only its own row. Temporary-table qualifiers can fail on SQLite 3.54
// RENAME; remove those identifier tokens without changing SQL literals or comments.
export function portableRebuildChecks(source) {
  // Lex the whole source first: a CHECK-looking line inside a multiline literal is data.
  const tokens = [
    ...source.matchAll(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_$]*|\S/g,
    ),
  ].filter(([token]) => !token.startsWith('--') && !token.startsWith('/*'));
  const removals = [];
  if (
    tokens.some(
      ({ 0: token, index: position }) =>
        ["'", '"', '`', '['].includes(token) ||
        (token === '/' && source.slice(position, position + 2) === '/*'),
    )
  )
    throw new Error('Malformed generated SQL token');
  const identifier = (token) => {
    if (token === undefined) return undefined;
    if (token.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
    if (token.startsWith('`')) return token.slice(1, -1).replaceAll('``', '`');
    if (token.startsWith('[')) return token.slice(1, -1).replaceAll(']]', ']');
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(token) ? token : undefined;
  };
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index][0].toUpperCase() !== 'CHECK' || tokens[index + 1]?.[0] !== '(') continue;
    let depth = 1;
    let end = index + 2;
    for (; end < tokens.length && depth > 0; end++) {
      const token = tokens[end][0];
      if (token === '(') depth++;
      else if (token === ')') depth--;
      else if (
        identifier(token)?.startsWith('__new_') === true &&
        tokens[end + 1]?.[0] === '.' &&
        identifier(tokens[end + 2]?.[0]) !== undefined
      ) {
        // Keep intervening whitespace/comments byte-identical; delete only qualifier and dot.
        for (const part of [tokens[end], tokens[end + 1]])
          removals.push([part.index, part.index + part[0].length]);
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
