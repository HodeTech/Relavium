/**
 * The `/agent` sheet is retired ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10,
 * MVP-11 step 4b): `/agent` is a report popup now, and nothing of the sheet is left behind. What fails here: a symbol of the sheet that is
 * written again, a second kind in the chat's one sheet slot, an overlay list or a doc line that still names the sheet, a golden producer or a
 * matrix surface of it, and a report surface that is missing from either chat host.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as agentSheet from './agent-sheet.js';
import { PRODUCERS } from './legend-golden/producers.js';
import { PRODUCT_SURFACES } from './surface-matrix/product-surfaces.js';
import { ALL_SURFACES } from './surface-matrix/all-surfaces.js';
import { REPORT_LANDMARKS } from './surface-matrix/report-fixture.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const TEST = /\.test\.tsx?$|\.test-support\.ts$/u;

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/u.test(entry) && !TEST.test(entry)) found.push(path);
  }
  return found;
}

const PRODUCTION = sources(SRC).map((path) => ({
  file: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

/** The identifiers of the retired sheet: the lines, the key fold, the slot kind, the host's opener and the failure sentence. */
const RETIRED = [
  'agentSheetLines',
  'foldAgentSheetKey',
  'agentChatSheet',
  'AgentSheetStep',
  'AGENT_UNREADABLE',
  'openAgentSheet',
];

const identifiersOf = (file: string): Set<string> => {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(SRC, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('nothing of the sheet is left in the source', () => {
  it.each(RETIRED)('no production file declares or uses %s', (name) => {
    const users = PRODUCTION.filter(({ file }) => identifiersOf(file).has(name)).map(
      ({ file }) => file,
    );
    expect(users).toEqual([]);
  });

  it('the module that remains exports the pure field formatting and no sheet', () => {
    expect(Object.keys(agentSheet).sort()).toEqual(
      [
        'BUILT_IN_AGENT_NOTE',
        'EMPTY_PROMPT',
        'INDENT',
        'LABEL_WIDTH',
        'NOT_SET',
        'NOT_WIRED_MARK',
        'agentNotice',
        'agentSheetBody',
        'agentSheetTitle',
        'boundToolsText',
        'effortText',
        'fieldLead',
        'nameText',
        'packedTools',
        'toolsParts',
        'wrappedTools',
      ].sort(),
    );
  });

  it('the chat’s one sheet slot holds one kind: the permissions sheet', () => {
    const file = ts.createSourceFile(
      'chat-sheet.ts',
      readFileSync(join(SRC, 'render/tui/chat-sheet.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const kinds: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertySignature(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'kind' &&
        node.type !== undefined &&
        ts.isLiteralTypeNode(node.type) &&
        ts.isStringLiteral(node.type.literal)
      )
        kinds.push(node.type.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(kinds).toEqual(['permissions']);
  });
});

describe('no overlay list or flag doc still names the sheet', () => {
  /** The files that list what owns the keyboard (the record of flags, the paste gate's flags) and the Home's state doc of the slot. */
  const LISTS = ['render/tui/overlay-flags.ts', 'render/tui/chat-input.ts'] as const;

  it.each(LISTS)('%s never writes `/agent` as one of the docked sheets', (file) => {
    const text = PRODUCTION.find((entry) => entry.file === file)?.text ?? '';
    expect(text).not.toMatch(/\/agent/u);
  });

  it('the Home controller’s doc of its sheet slot names the permissions sheet only', () => {
    const text =
      PRODUCTION.find((entry) => entry.file === 'render/tui/home-controller.ts')?.text ?? '';
    const doc = text.slice(
      text.indexOf('The open docked sheet of a live in-Home chat'),
      text.indexOf('readonly chatSheet:'),
    );
    expect(doc.length).toBeGreaterThan(100);
    expect(doc).not.toMatch(/\/agent/u);
  });
});

describe('the golden and the matrix follow', () => {
  it('has no producer of the sheet, and one for each report popup', () => {
    const ids = PRODUCERS.map((producer) => producer.id);
    expect(ids).not.toContain('agent-sheet');
    expect(ids).not.toContain('agent-sheet-roles');
    for (const id of ['agent-popup', 'cost-popup', 'workflows-popup', 'help-popup'])
      expect(ids).toContain(id);
  });

  it.each(['chat-overlay-rows.test.tsx', 'chat-native-card-busy.test.tsx'])(
    '%s lists the chat’s own overlays and no longer names the sheet among them',
    (file) => {
      const text = readFileSync(join(SRC, 'render/tui', file), 'utf8');
      // The lists these tests filter the matrix surfaces by: a name of the retired sheet there filters nothing and reads as if the sheet were still drawn.
      expect(text).toContain("'sheet-permissions'");
      expect(text).not.toContain('sheet-agent');
    },
  );

  it('has no matrix surface or product row of the sheet, and every report state in both chat hosts', () => {
    const registered = ALL_SURFACES.map((surface) => surface.id);
    const rows = PRODUCT_SURFACES.map((surface) => surface.id);
    expect([...registered, ...rows].filter((id) => id.endsWith('sheet-agent'))).toEqual([]);
    for (const state of Object.keys(REPORT_LANDMARKS))
      for (const host of ['chat', 'standalone-chat']) {
        expect(registered).toContain(`${host}.report-${state}`);
        expect(rows).toContain(`${host}.report-${state}`);
      }
  });
});
