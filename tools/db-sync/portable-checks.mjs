// Drizzle qualifies CHECK columns with its temporary rebuild table. SQLite 3.54 rejects
// those qualifiers on RENAME. CHECKs only see their own row, so unqualified identifiers
// preserve the constraint while avoiding a reference to the temporary table name.
export function portableRebuildChecks(source) {
  return source.replace(
    /^(\s*CONSTRAINT\s+"[^"\n]+"\s+CHECK\()(.*)(\),?\s*)$/gm,
    (_line, prefix, expression, suffix) => {
      // Consume single-quoted SQL literals first: never rewrite text inside a literal.
      const portable = expression.replace(
        /'(?:''|[^'])*'|"__new_[A-Za-z0-9_]+"\.(?=")/g,
        (token) => (token.startsWith("'") ? token : ''),
      );
      return prefix + portable + suffix;
    },
  );
}
