/**
 * The eager half of the report popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10): which typed lines it recognises (and that every other form is left to the command's own dispatch), what a port has to hold for a report
 * to be a popup, and that the popups' code is loaded by a dynamic import and never by a static one.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  openReport,
  parseReportLine,
  REPORTS,
  reportAvailable,
  type ParsedReportLine,
  type ReportKind,
  type ReportsPort,
} from './report-port.js';
import { reportRig } from './report.test-support.js';

describe('parseReportLine', () => {
  it.each([
    ['/agent', { kind: 'agent' }],
    ['/cost', { kind: 'cost', release: false }],
    ['/cost --release', { kind: 'cost', release: true }],
    ['/workflows', { kind: 'workflows' }],
    ['/help', { kind: 'help' }],
    ['  /agent  ', { kind: 'agent' }],
    ['\t/cost\t--release\t', { kind: 'cost', release: true }],
    ['/cost   --release', { kind: 'cost', release: true }],
    ['/cost --release --release', { kind: 'cost', release: true }],
  ] satisfies readonly (readonly [string, ParsedReportLine])[])(
    '%j is recognised',
    (line, parsed) => {
      expect(parseReportLine(line)).toEqual(parsed);
    },
  );

  it.each([
    '/agent now',
    '/agent --release',
    '/cost --force',
    '/cost release',
    '/cost --release now',
    '/workflows list',
    '/help me',
    '/help --deep',
    '/doctor',
    '/AGENT',
    'agent',
    '/agents',
    '/cost--release',
    '',
    '   ',
    'hello /help',
  ])('%j is left to the command’s own dispatch', (line) => {
    expect(parseReportLine(line)).toBeUndefined();
  });

  it('only a /cost line carries release', () => {
    for (const kind of ['agent', 'workflows', 'help'] as const)
      expect(parseReportLine(`/${kind}`)).not.toHaveProperty('release');
  });
});

describe('REPORTS: one table for the line, the availability and the opener', () => {
  it('names each report once, by the command that is its own name', () => {
    expect(REPORTS.map((report) => [report.kind, report.command, report.takesRelease])).toEqual([
      ['agent', '/agent', false],
      ['cost', '/cost', true],
      ['workflows', '/workflows', false],
      ['help', '/help', false],
      // `/export`'s confirmation popup (ADR-0148 §10, MVP-11 unit 6): routed and opened as the reports are
      ['export', '/export', false],
    ]);
  });

  it.each(REPORTS.map((report) => [report.kind, report.command] as const))(
    '%s: its command parses to it, and a port that holds it opens the popup of that name',
    (kind, command) => {
      expect(parseReportLine(command)?.kind).toBe(kind);
      const r = reportRig();
      const port: ReportsPort = {
        surface: 'standalone-chat',
        agent: () => {
          throw new Error('the view cannot be made');
        },
        cost: { read: () => new Promise(() => undefined), release: vi.fn() },
        workflows: { read: () => new Promise(() => undefined) },
        help: { keys: [] },
        export: {
          prepare: () => ({ target: '.relavium/workflows/hello.relavium.yaml', overwrites: false }),
          commit: () => ({ target: '.relavium/workflows/hello.relavium.yaml' }),
          failure: () => 'unused',
          review: 'unused',
        },
      };
      const opened = r.open(port, { kind });
      expect(opened.opened).toBe(true);
      expect(r.host.getSnapshot().frame?.spec.id).toBe(kind);
    },
  );
});

describe('reportAvailable', () => {
  const full: ReportsPort = {
    surface: 'standalone-chat',
    agent: () => {
      throw new Error('not called');
    },
    cost: { read: vi.fn(), release: vi.fn() },
    workflows: { read: vi.fn() },
    help: { keys: [] },
  };

  it.each(['agent', 'cost', 'workflows', 'help'] as const)(
    'a report is a popup only where its own member is wired: %s',
    (kind: ReportKind) => {
      expect(reportAvailable(full, kind)).toBe(true);
      expect(reportAvailable({ surface: 'standalone-chat' }, kind)).toBe(false);
      for (const other of ['agent', 'cost', 'workflows', 'help'] as const) {
        if (other === kind) continue;
        const only: ReportsPort = { surface: 'home-chat', [other]: full[other] };
        expect(reportAvailable(only, kind)).toBe(false);
      }
    },
  );
});

describe('the popups load on first use', () => {
  it('report-port.ts reaches the session only through a dynamic import, never a static one', () => {
    const source = readFileSync(new URL('./report-port.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('report-port.ts', source, ts.ScriptTarget.Latest, true);
    const staticValueImports: string[] = [];
    const dynamicImports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && !(node.importClause?.isTypeOnly ?? false)) {
        const specifier = node.moduleSpecifier;
        if (ts.isStringLiteral(specifier)) staticValueImports.push(specifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument !== undefined && ts.isStringLiteral(argument))
          dynamicImports.push(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(dynamicImports).toEqual(['./report-session.js']);
    // No static import of a value: everything it imports is a type, so nothing of the popups loads with the host.
    expect(staticValueImports).toEqual([]);
  });

  it('openReport opens the popup the line names over the host it was given', async () => {
    const r = reportRig();
    await openReport({
      host: r.host,
      port: { surface: 'standalone-chat', help: { keys: [{ keys: 'Enter', verb: 'send it' }] } },
      line: { kind: 'help' },
      origin: 'chat',
      turnInFlight: () => false,
    });
    expect(r.host.getSnapshot().frame?.spec.id).toBe('help');
  });

  it('a host that did not wire the report opens nothing and says nothing', async () => {
    const r = reportRig();
    await openReport({
      host: r.host,
      port: { surface: 'standalone-chat' },
      line: { kind: 'workflows' },
      origin: 'chat',
      turnInFlight: () => false,
    });
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });
});
