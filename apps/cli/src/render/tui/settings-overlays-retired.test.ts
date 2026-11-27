/**
 * The overlays the settings popups replaced are retired ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, §10; [ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2 as a popup;
 * MVP-11 step 5): ONE guard over one read of the source, with a block per overlay under its own name, so each retirement is still tested by name
 * and none of them can come back unseen.
 *
 * - **effort-overlay-retired**: `/effort` is a settings popup (`popups/effort-popup.ts`); the tier overlay, its gate and its footer are gone, and
 *   so is the paste gate's field for it (a paste into a popup is the popup host's).
 * - **model-picker-retired**: `/models` is a settings popup (`popups/models-popup.ts`, `popups/models-session.ts`) in both chats and on the bare
 *   Home; the picker's fold, its view and the tier list only its effort sub-step drew are gone, with the residue it wrote and the stale
 *   non-interactive sentence that named the project layer.
 * - **chat-sheet-retired**: in a chat `/permissions` is a settings popup; the chat has no sheet slot at all. The sheet's model, its port and its
 *   view are deleted (review round 1 of MVP-11 unit 8, D-3): the popup (`popups/permissions-popup.ts`) is the one implementation. What must
 *   stay: the bare Home's `/permissions` popup (MVP-11 unit 8: the tab is retired), the registry's placements as a popup, and the text a plain,
 *   `--json` or one-shot chat prints, byte for byte.
 *
 * Each block fails on: a symbol of the overlay written again, a module of it that comes back or is imported, a flag of it in the record of what
 * owns the keyboard or in the paste gate, a golden producer or a matrix surface of it, and the popup's surfaces missing from a host.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { placementOf } from '../../commands/repl-commands.js';
import { NOT_AVAILABLE } from '../../permissions/chat-permissions.js';
import { PRODUCERS } from './legend-golden/producers.js';
import { NO_OVERLAYS, pasteFlagsFrom } from './overlay-flags.js';
import { ALL_SURFACES } from './surface-matrix/all-surfaces.js';
import { PERMISSIONS_LANDMARKS } from './surface-matrix/permissions-fixture.js';
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

/** Every production file, read once for all three blocks. */
const PRODUCTION = sources(SRC).map((path) => ({
  file: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

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

/** Every identifier of every production file, parsed once. */
const IDENTIFIERS = PRODUCTION.map(({ file, text }) => ({
  file,
  names: identifiersOf(text, file),
}));

const ids = (list: readonly { readonly id: string }[]): string[] => list.map((entry) => entry.id);
const REGISTERED = ids(ALL_SURFACES);
const ROWS = ids(PRODUCT_SURFACES);
const PRODUCER_IDS = ids(PRODUCERS);

/** One retired overlay: what of it must be gone, and the popup that replaced it, which must be there. */
interface RetiredOverlay {
  /** The guard's name (it was a file of its own). */
  readonly name: string;
  /** Its identifiers: no production file declares or uses one. */
  readonly identifiers: readonly string[];
  /** Its modules, relative to `src`: none exists, and nothing imports one. */
  readonly modules: readonly string[];
  /** Its key in the record of what owns the keyboard (`NO_OVERLAYS`) and in the paste gate (`pasteFlagsFrom`), which must not exist. */
  readonly overlayFlag: string;
  readonly pasteFlag: string;
  /** The golden producers of it, gone, and of the popup, there. */
  readonly producersGone: readonly string[];
  readonly producersThere: readonly string[];
  /** The suffix every matrix surface or product row of it ended with, of which none is left. */
  readonly surfaceSuffix: string;
  /** The popup's surfaces, each in each of its hosts, registered in the matrix and listed as a product row. */
  readonly popupSurfaces: readonly string[];
}

const RETIRED: readonly RetiredOverlay[] = [
  {
    name: 'effort-overlay-retired',
    identifiers: [
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
    ],
    modules: ['render/tui/effort-picker.ts'],
    overlayFlag: 'effortPicker',
    pasteFlag: 'effortPickerOpen',
    producersGone: ['chat-effort-overlay', 'home-effort-overlay'],
    producersThere: ['effort-popup'],
    surfaceSuffix: 'effort-picker',
    popupSurfaces: ['chat.settings-effort', 'standalone-chat.settings-effort'],
  },
  {
    name: 'model-picker-retired',
    identifiers: [
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
    ],
    modules: [
      'render/tui/model-picker.ts',
      'render/tui/model-picker-view.tsx',
      'render/tui/effort-tier-list.tsx',
    ],
    overlayFlag: 'modelPicker',
    pasteFlag: 'modelPickerOpen',
    producersGone: ['model-picker-view', 'effort-tier-list'],
    producersThere: ['models-popup'],
    surfaceSuffix: 'model-picker',
    popupSurfaces: ['home', 'chat', 'standalone-chat'].flatMap((host) =>
      ['settings-models', 'settings-models-apply'].map((step) => `${host}.${step}`),
    ),
  },
  {
    name: 'chat-sheet-retired',
    identifiers: [
      'ChatSheetState',
      'permissionsChatSheet',
      'permissionsSheetOf',
      'ChatSheetView',
      'ChatSheetViewProps',
      'chatSheet',
      'chatSheetRef',
      'applyChatSheet',
      'setChatSheet',
      'routeChatSheetKey',
      'openPermissionsSheet',
      'sheetMayOpen',
      'chatSheetOpen',
    ],
    modules: ['render/tui/chat-sheet.ts', 'render/tui/chat-sheet-view.tsx'],
    overlayFlag: 'chatSheet',
    pasteFlag: 'chatSheetOpen',
    producersGone: [],
    producersThere: ['permissions-popup'],
    surfaceSuffix: 'sheet-permissions',
    popupSurfaces: Object.keys(PERMISSIONS_LANDMARKS).flatMap((state) =>
      ['chat', 'standalone-chat'].map((host) => `${host}.permissions-${state}`),
    ),
  },
];

/** The name a module is imported by (`./model-picker-view.js`). */
const importName = (module: string): string =>
  module
    .split('/')
    .at(-1)
    ?.replace(/\.tsx?$/u, '') ?? module;

describe.each(RETIRED)('$name', (overlay) => {
  it.each(overlay.identifiers)('no production file declares or uses %s', (name) => {
    expect(IDENTIFIERS.filter(({ names }) => names.has(name)).map(({ file }) => file)).toEqual([]);
  });

  it.each(overlay.modules)('%s is gone, and nothing imports it', (module) => {
    expect(existsSync(join(SRC, module))).toBe(false);
    const imported = new RegExp(`from\\s+'[^']*/${importName(module)}\\.js'`, 'u');
    expect(PRODUCTION.filter(({ text }) => imported.test(text)).map(({ file }) => file)).toEqual(
      [],
    );
  });

  it('the record of what owns the keyboard and the paste gate have no flag of it', () => {
    expect(Object.keys(NO_OVERLAYS)).not.toContain(overlay.overlayFlag);
    expect(Object.keys(pasteFlagsFrom(NO_OVERLAYS))).not.toContain(overlay.pasteFlag);
    expect(
      IDENTIFIERS.filter(({ names }) => names.has(overlay.pasteFlag)).map(({ file }) => file),
    ).toEqual([]);
  });

  it('the golden has no producer of it, and one for the popup', () => {
    for (const id of overlay.producersGone) expect(PRODUCER_IDS).not.toContain(id);
    for (const id of overlay.producersThere) expect(PRODUCER_IDS).toContain(id);
  });

  it('the matrix has no surface or product row of it, and the popup’s on every host it opens on', () => {
    expect([...REGISTERED, ...ROWS].filter((id) => id.endsWith(overlay.surfaceSuffix))).toEqual([]);
    expect(overlay.popupSurfaces.length).toBeGreaterThan(0);
    for (const id of overlay.popupSurfaces) {
      expect(REGISTERED).toContain(id);
      expect(ROWS).toContain(id);
    }
  });
});

describe('effort-overlay-retired: what is particular to it', () => {
  it.each(['chat-overlay-rows.test.tsx', 'chat-native-card-busy.test.tsx'])(
    '%s no longer names the overlay among the chat’s own overlays',
    (file) => {
      const text = readFileSync(join(SRC, 'render/tui', file), 'utf8');
      expect(text).not.toContain("'effort-picker'");
    },
  );
});

describe('model-picker-retired: what is particular to it', () => {
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

describe('chat-sheet-retired: what stays', () => {
  it('the bare Home’s Permissions popup is the one implementation of the lists: the sheet, its port and its view are gone (review round 1, D-3)', () => {
    const popup =
      PRODUCTION.find((entry) => entry.file === 'popups/permissions-popup.ts')?.text ?? '';
    expect(popup).toContain('export function permissionEntries(');
    for (const gone of [
      'render/tui/permissions-sheet.ts',
      'render/tui/permissions-sheet-port.ts',
      'render/tui/permissions-sheet-view.tsx',
    ])
      expect(existsSync(join(SRC, gone)), `${gone} is deleted`).toBe(false);
    for (const entry of PRODUCTION)
      expect(entry.text, `${entry.file} imports no permissions sheet`).not.toMatch(
        /from '[^']*permissions-sheet(?:-port|-view)?\.js'/u,
      );
    const tabHost = PRODUCTION.find((entry) => entry.file === 'render/tui/tab-host.ts')?.text ?? '';
    expect(tabHost, 'the tab host no longer draws the sheet').not.toContain('permissions-sheet');
    expect(ROWS).toContain('home.permissions-popup');
    expect(ROWS).not.toContain('home.tab-permissions');
  });

  it('the registry’s placement of /permissions is a popup on the Home, as in both chats (MVP-11 unit 8)', () => {
    expect(placementOf('permissions', 'standalone-chat')?.surface).toBe('popup');
    expect(placementOf('permissions', 'home-chat')?.surface).toBe('popup');
    expect(placementOf('permissions', 'home')?.surface).toBe('popup');
  });

  it('a plain, `--json` or one-shot chat prints the same sentence, byte for byte, from the same dispatch line', () => {
    expect(NOT_AVAILABLE).toBe('Remembered commands are not available in this chat.');
    const chat = PRODUCTION.find((entry) => entry.file === 'commands/chat.ts')?.text ?? '';
    expect(chat).toContain('emitOutput(PERMISSIONS_NOT_AVAILABLE);');
  });

  it('the session hands no driver a permissions port of its own beside the popup’s (the sheet’s field is gone)', () => {
    const chat = PRODUCTION.find((entry) => entry.file === 'commands/chat.ts')?.text ?? '';
    // Exactly one permissions port is built per chat session: the settings popup's member.
    expect(chat.match(/createPermissionsPort\(/gu)).toHaveLength(1);
  });
});
