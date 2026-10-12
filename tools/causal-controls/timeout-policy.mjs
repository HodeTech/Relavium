/** Statically refuse per-hook budgets Vitest does not expose through TestContext. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const maxMilliseconds = 15_000;
const hooks = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);

function numericTimeout(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isNumericLiteral(node)) return undefined;
  return Number(node.text.replaceAll('_', ''));
}

export function assertDeclaredHookTimeouts(graph, files) {
  for (const path of new Set(files)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(join(graph, path), 'utf8'),
      ts.ScriptTarget.Latest,
      false,
      path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const hookNames = new Set(hooks);
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        ['vitest', '@vitest/runner'].includes(statement.moduleSpecifier.text) &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const specifier of statement.importClause.namedBindings.elements)
          if (hooks.has(specifier.propertyName?.text ?? specifier.name.text))
            hookNames.add(specifier.name.text);
    }
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        hookNames.has(node.expression.text) &&
        node.arguments.length > 1
      ) {
        const value = numericTimeout(node.arguments[1]);
        assert.ok(
          value !== undefined &&
            Number.isSafeInteger(value) &&
            value > 0 &&
            value <= maxMilliseconds,
          `CAUSAL_TIMEOUT_BUDGET: ${path}: ${node.expression.text} declared hook timeout exceeds ${maxMilliseconds} ms or is not statically bounded`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
