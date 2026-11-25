/**
 * The `/models` picker overlay is retired ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 step 5): `/models` is a settings popup now (`popups/models-popup.ts`, `popups/models-session.ts`), in both chats and on the bare
 * Home, and nothing of the overlay is left behind. What fails here: a symbol of the overlay that is written again, one of its three modules (the
 * picker's fold, its view, and the tier list only its effort sub-step drew), an overlay flag or a paste flag for it, a host's state or routing of
 * it, a golden producer or a matrix surface of it, the stale non-interactive sentence that named the project layer, and the popup's surfaces
 * missing from a host.
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

/** The identifiers of the retired overlay: its state, its fold and view, the hosts' openers, routers and state, its flags and its hints. */
const RETIRED = [
  'ModelPickerState',
  'ModelPickerStep',
  'ModelPickerKey',
  'ModelPickerView',
  'ModelPickerScope',
  'ModelPickerViewProps',
  'foldModelPickerKey',
  'visibleModels',
  'modelWindow',
  'EFFORT_STEP_FOOTER',
  'EffortTierList',
  'openModelPicker',
  'routeModelPickerKey',
  'acceptModelPick',
  'applyModelPicker',
  'modelPickerRef',
  'modelPicker',
  'modelPickerOpen',
  'pickerEpoch',
  'pickerEpochRef',
  'runPickerRefresh',
  'applyPickerRefresh',
  'applyRefreshResult',
  'acceptModel',
  'applyLiveSessionPick',
  'applyEffortOnlyUpdate',
  'writeNextSessionDefault',
  'defaultWriteNotice',
  'alreadyOnModelHint',
  'PICKER_NO_KEY_REMEDY_IN_A_CHAT',
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

  it.each([
    'render/tui/model-picker.ts',
    'render/tui/model-picker-view.tsx',
    'render/tui/effort-tier-list.tsx',
  ])('%s is gone, and nothing imports it', (module) => {
    expect(existsSync(join(SRC, module))).toBe(false);
    const name =
      module
        .split('/')
        .at(-1)
        ?.replace(/\.tsx?$/u, '') ?? module;
    expect(
      PRODUCTION.filter(({ text }) =>
        new RegExp(`from\\s+'[^']*/${name}\\.js'`, 'u').test(text),
      ).map(({ file }) => file),
    ).toEqual([]);
  });

  it('the record of what owns the keyboard has no flag for it', () => {
    expect(Object.keys(NO_OVERLAYS)).not.toContain('modelPicker');
  });

  it('the residue the picker wrote is gone: no catalog-read note, no same-model or set-default note, no failed-switch note', () => {
    const all = PRODUCTION.map(({ text }) => text).join('\n');
    expect(all).not.toContain('/models: could not read the model catalog.');
    expect(all).not.toContain('— applies to your next chat session.');
    expect(all).not.toContain('/models could not switch the model — keeping this conversation.');
    expect(all).not.toContain('Reasoning effort set to');
  });

  it('a non-interactive chat names the layer the Home writes, `[preferences].default_model`, not the project layer', () => {
    const chat = readFileSync(join(SRC, 'commands/chat.ts'), 'utf8');
    expect(chat).toContain(
      "'/models needs an interactive terminal to switch the model live. From a pipe, set `[preferences].default_model` ' +",
    );
    expect(chat).not.toContain('From a pipe, set `[chat].default_model`');
  });
});

describe('the golden and the matrix follow', () => {
  it('has no producer of the picker or its tier list, and one for the popup', () => {
    const ids = PRODUCERS.map((producer) => producer.id);
    expect(ids).not.toContain('model-picker-view');
    expect(ids).not.toContain('effort-tier-list');
    expect(ids).toContain('models-popup');
  });

  it('has no matrix surface or product row of the picker, and the popup’s on every host, on both steps', () => {
    const registered = ALL_SURFACES.map((surface) => surface.id);
    const rows = PRODUCT_SURFACES.map((surface) => surface.id);
    expect([...registered, ...rows].filter((id) => id.endsWith('model-picker'))).toEqual([]);
    for (const host of ['home', 'chat', 'standalone-chat'])
      for (const step of ['settings-models', 'settings-models-apply']) {
        expect(registered).toContain(`${host}.${step}`);
        expect(rows).toContain(`${host}.${step}`);
      }
  });
});
