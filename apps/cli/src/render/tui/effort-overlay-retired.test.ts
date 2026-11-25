/**
 * The `/effort` tier overlay is retired ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 step 5): `/effort` is a settings popup now (`popups/effort-popup.ts`), and nothing of the overlay is left behind. What fails
 * here: a symbol of the overlay that is written again, its module, an overlay flag or a host field for it, a golden producer or a matrix surface
 * of it, and the popup's surface missing from either chat host. The tier LIST (`effort-tier-list.tsx`) stays: the `/models` effort sub-step draws
 * it, and that picker is a later increment of the step.
 *
 * The paste gate's field for the overlay (`effortPickerOpen` of `chat-input.ts`'s `PasteEditableFlags`) is gone too: a paste into a popup is
 * the popup host's.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { PRODUCERS } from './legend-golden/producers.js';
import { NO_OVERLAYS } from './overlay-flags.js';
import { ALL_SURFACES } from './surface-matrix/all-surfaces.js';
import { PRODUCT_SURFACES } from './surface-matrix/product-surfaces.js';

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

/** The identifiers of the retired overlay: its state and fold, its gate, the hosts' openers and routers, its footer and its state field. */
const RETIRED = [
  'EffortPickerState',
  'EffortPickerStep',
  'foldEffortPickerKey',
  'initialEffortPickerState',
  'canControlEffort',
  'canOpenEffortPicker',
  'openEffortPicker',
  'routeEffortPickerKey',
  'applyEffortPicker',
  'effortPickerRef',
  'effortPicker',
  'EFFORT_OVERLAY_FOOTER',
];

const identifiersOf = (text: string, file: string): Set<string> => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const IDENTIFIERS = PRODUCTION.map(({ file, text }) => ({
  file,
  names: identifiersOf(text, file),
}));

describe('nothing of the overlay is left in the source', () => {
  it.each(RETIRED)('no production file declares or uses %s', (name) => {
    expect(IDENTIFIERS.filter(({ names }) => names.has(name)).map(({ file }) => file)).toEqual([]);
  });

  it('its module is gone, and nothing imports it', () => {
    expect(existsSync(join(SRC, 'render/tui/effort-picker.ts'))).toBe(false);
    expect(
      PRODUCTION.filter(({ text }) => /from\s+'[^']*\/effort-picker\.js'/u.test(text)).map(
        ({ file }) => file,
      ),
    ).toEqual([]);
  });

  it('the paste gate has no field for the retired overlay (the popup host takes a paste itself)', () => {
    expect(
      IDENTIFIERS.filter(({ names }) => names.has('effortPickerOpen')).map(({ file }) => file),
    ).toEqual([]);
  });

  it('the record of what owns the keyboard has no flag for it', () => {
    expect(Object.keys(NO_OVERLAYS)).not.toContain('effortPicker');
  });
});

describe('the golden and the matrix follow', () => {
  it('has no producer of the overlay’s footer, and one for the popup', () => {
    const ids = PRODUCERS.map((producer) => producer.id);
    expect(ids).not.toContain('chat-effort-overlay');
    expect(ids).not.toContain('home-effort-overlay');
    expect(ids).toContain('effort-popup');
  });

  it('has no matrix surface or product row of the overlay, and the popup’s in both chat hosts', () => {
    const registered = ALL_SURFACES.map((surface) => surface.id);
    const rows = PRODUCT_SURFACES.map((surface) => surface.id);
    expect([...registered, ...rows].filter((id) => id.endsWith('effort-picker'))).toEqual([]);
    for (const host of ['chat', 'standalone-chat']) {
      expect(registered).toContain(`${host}.settings-effort`);
      expect(rows).toContain(`${host}.settings-effort`);
    }
  });

  it.each(['chat-overlay-rows.test.tsx', 'chat-native-card-busy.test.tsx'])(
    '%s no longer names the overlay among the chat’s own overlays',
    (file) => {
      const text = readFileSync(join(SRC, 'render/tui', file), 'utf8');
      expect(text).not.toContain("'effort-picker'");
    },
  );
});
