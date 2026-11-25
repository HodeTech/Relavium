/**
 * The chat's docked `/permissions` sheet is retired ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2 as a popup, [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10, MVP-11 step 5c):
 * in a chat `/permissions` is a settings popup now, and the chat has no sheet slot at all. What fails here: a symbol of the slot, of its view or of
 * its host routing that is written again; a file of it that comes back; a flag of it in the record of what owns the keyboard or in the paste
 * gate; a matrix surface or a product row of it; a chat permissions surface missing from either host. What must stay: the bare Home's
 * Permissions TAB over the same pure model (`permissions-sheet.ts`), the registry's chat placement as a popup, and the text a plain, `--json`
 * or one-shot chat prints, byte for byte.
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

const PRODUCTION = sources(SRC).map((path) => ({
  file: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

/** The identifiers of the retired slot: its type and helpers, its view, the hosts' state and routing, and its flags. */
const RETIRED = [
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
];

const identifiersOf = (file: string, text: string): Set<string> => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('nothing of the chat’s sheet slot is left in the source', () => {
  it('its two files are gone, and no production file imports them', () => {
    expect(existsSync(join(SRC, 'render/tui/chat-sheet.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'render/tui/chat-sheet-view.tsx'))).toBe(false);
    const importers = PRODUCTION.filter(({ text }) =>
      /from\s+'[^']*\/chat-sheet(?:-view)?\.js'/u.test(text),
    ).map(({ file }) => file);
    expect(importers).toEqual([]);
  });

  it.each(RETIRED)('no production file declares or uses %s', (name) => {
    const users = PRODUCTION.filter(({ file, text }) => identifiersOf(file, text).has(name)).map(
      ({ file }) => file,
    );
    expect(users).toEqual([]);
  });

  it('the record of what owns the keyboard and the paste gate have no flag of it', () => {
    expect(Object.keys(NO_OVERLAYS)).not.toContain('chatSheet');
    expect(Object.keys(pasteFlagsFrom(NO_OVERLAYS))).not.toContain('chatSheetOpen');
  });
});

describe('what stays', () => {
  it('the bare Home’s Permissions tab, over the same pure model', () => {
    const tabHost = PRODUCTION.find((entry) => entry.file === 'render/tui/tab-host.ts')?.text ?? '';
    expect(tabHost).toContain("from './permissions-sheet.js'");
    expect(existsSync(join(SRC, 'render/tui/permissions-sheet.ts'))).toBe(true);
    expect(PRODUCT_SURFACES.map((surface) => surface.id)).toContain('home.tab-permissions');
    expect(PRODUCERS.map((producer) => producer.id)).toContain('permissions-sheet');
  });

  it('the registry’s chat placement of /permissions is a popup, and the Home’s a screen', () => {
    expect(placementOf('permissions', 'standalone-chat')?.surface).toBe('popup');
    expect(placementOf('permissions', 'home-chat')?.surface).toBe('popup');
    expect(placementOf('permissions', 'home')?.surface).toBe('screen');
  });

  it('a plain, `--json` or one-shot chat prints the same sentence, byte for byte, from the same dispatch line', () => {
    expect(NOT_AVAILABLE).toBe('Remembered commands are not available in this chat.');
    const chat = PRODUCTION.find((entry) => entry.file === 'commands/chat.ts')?.text ?? '';
    expect(chat).toContain('emitOutput(PERMISSIONS_NOT_AVAILABLE);');
  });
});

describe('the matrix and the golden follow', () => {
  it('no matrix surface or product row of the sheet; every permissions popup state in both chat hosts, registered and listed', () => {
    const registered = ALL_SURFACES.map((surface) => surface.id);
    const rows = PRODUCT_SURFACES.map((surface) => surface.id);
    expect([...registered, ...rows].filter((id) => id.endsWith('sheet-permissions'))).toEqual([]);
    for (const state of Object.keys(PERMISSIONS_LANDMARKS))
      for (const host of ['chat', 'standalone-chat']) {
        expect(registered).toContain(`${host}.permissions-${state}`);
        expect(rows).toContain(`${host}.permissions-${state}`);
      }
  });

  it('the popup has its golden producer', () => {
    expect(PRODUCERS.map((producer) => producer.id)).toContain('permissions-popup');
  });
});
