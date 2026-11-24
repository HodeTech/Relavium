import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { NoticeSurface } from './notice-surface.js';
import {
  chatSurfaceOf,
  isChatSurface,
  isTuiSurface,
  noticeSurfaceOf,
  type Surface,
} from './surface.js';

/**
 * **One `Surface`** ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7, MVP-11 Step 3). The four places the CLI
 * runs, the helpers that narrow them, and a guard that holds the source to the one spelling: a module whose contract is narrower writes
 * `Extract<Surface, …>` or `Exclude<Surface, …>`, and no file but `surface.ts` spells a union of these literals again.
 */

/** Every surface once. A `Record` over the type makes a value added to `Surface` a compile error here, not a value the tests forget. */
const EVERY_SURFACE: Readonly<Record<Surface, true>> = {
  shell: true,
  home: true,
  'home-chat': true,
  'standalone-chat': true,
};
const SURFACES = Object.keys(EVERY_SURFACE) as readonly Surface[];

/** What each helper answers for each surface: a table over the type, so a surface a helper does not decide is a compile error too. */
const EXPECTED: Readonly<
  Record<
    Surface,
    {
      readonly tui: boolean;
      readonly notice: NoticeSurface;
      readonly chat: boolean;
      readonly chatOf: Surface;
    }
  >
> = {
  shell: { tui: false, notice: 'shell', chat: false, chatOf: 'shell' },
  home: { tui: true, notice: 'tui', chat: false, chatOf: 'home-chat' },
  'home-chat': { tui: true, notice: 'tui', chat: true, chatOf: 'home-chat' },
  'standalone-chat': { tui: true, notice: 'tui', chat: true, chatOf: 'standalone-chat' },
};

describe('the four surfaces and the helpers that narrow them', () => {
  it('has four surfaces', () => {
    expect([...SURFACES].sort()).toEqual(['home', 'home-chat', 'shell', 'standalone-chat']);
  });

  it.each(SURFACES)('%s: every helper answers, and as the table says', (surface) => {
    const expected = EXPECTED[surface];
    expect(isTuiSurface(surface)).toBe(expected.tui);
    expect(noticeSurfaceOf(surface)).toBe(expected.notice);
    expect(isChatSurface(surface)).toBe(expected.chat);
    expect(chatSurfaceOf(surface)).toBe(expected.chatOf);
  });

  it('pins noticeSurfaceOf: the shell reads the scripted wording, the Home and both chats the TUI’s', () => {
    expect(SURFACES.map((surface) => [surface, noticeSurfaceOf(surface)])).toEqual([
      ['shell', 'shell'],
      ['home', 'tui'],
      ['home-chat', 'tui'],
      ['standalone-chat', 'tui'],
    ]);
  });

  it('is a TUI surface exactly when its notices are the TUI’s', () => {
    for (const surface of SURFACES)
      expect(noticeSurfaceOf(surface) === 'tui', surface).toBe(isTuiSurface(surface));
  });

  it('reads the shell as the shell and the Home as the chat it hosts', () => {
    expect(chatSurfaceOf('shell')).toBe('shell');
    expect(chatSurfaceOf('home')).toBe('home-chat');
    for (const surface of SURFACES) {
      // A chat reads as a chat or as the shell, never as the Home, and reading it again changes nothing.
      expect(chatSurfaceOf(surface), surface).not.toBe('home');
      expect(chatSurfaceOf(chatSurfaceOf(surface)), surface).toBe(chatSurfaceOf(surface));
    }
  });

  it('narrows the type, so a caller needs no cast', () => {
    // The assignments are the check (the typecheck compiles them); the runtime answers hold the same meaning.
    const chatOf = (surface: Surface): 'home-chat' | 'standalone-chat' | undefined =>
      isChatSurface(surface) ? surface : undefined;
    const tuiOf = (surface: Surface): 'home' | 'home-chat' | 'standalone-chat' | undefined =>
      isTuiSurface(surface) ? surface : undefined;
    expect(SURFACES.map(chatOf)).toEqual([undefined, undefined, 'home-chat', 'standalone-chat']);
    expect(SURFACES.map(tuiOf)).toEqual([undefined, 'home', 'home-chat', 'standalone-chat']);
  });
});

// ── The guard: no second union of the four literals ───────────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../', import.meta.url));
const SURFACE_FILE = 'render/surface.ts';
const LITERALS: ReadonlySet<string> = new Set(SURFACES);

/** The union types of a source text that spell two or more surfaces, as `file:line: text`, except those written as `Extract`/`Exclude` of `Surface`. */
function surfaceUnionsIn(file: string, text: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  /** `Extract<Surface, …>` and `Exclude<Surface, …>`: the one allowed way to narrow the type, whose second argument names the values. */
  const isNarrowing = (union: ts.UnionTypeNode): boolean => {
    const parent = union.parent;
    if (!ts.isTypeReferenceNode(parent) || !ts.isIdentifier(parent.typeName)) return false;
    if (parent.typeName.text !== 'Extract' && parent.typeName.text !== 'Exclude') return false;
    const [base, narrowed] = parent.typeArguments ?? [];
    return (
      narrowed === union &&
      base !== undefined &&
      ts.isTypeReferenceNode(base) &&
      base.typeName.getText(sf) === 'Surface'
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node) && !isNarrowing(node)) {
      const spelled = node.types.filter(
        (member) =>
          ts.isLiteralTypeNode(member) &&
          ts.isStringLiteral(member.literal) &&
          LITERALS.has(member.literal.text),
      );
      if (spelled.length >= 2) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${file}:${String(line + 1)}: ${node.getText(sf)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.d\.ts$/u.test(entry.name) &&
      !/\.test\.tsx?$/u.test(entry.name)
    )
      found.push(full);
  }
  return found;
}

describe('no file but surface.ts spells a union of surfaces (ADR-0145 §7)', () => {
  it('finds a union of two or more surfaces, however it is written', () => {
    const spelled = (text: string): number => surfaceUnionsIn('x.ts', text).length;
    expect(spelled("type A = 'home' | 'standalone-chat';")).toBe(1);
    expect(spelled("type A =\n  | 'shell'\n  | 'home'\n  | 'home-chat';")).toBe(1);
    expect(spelled("interface B { readonly surface?: 'home' | 'home-chat' | undefined }")).toBe(1);
    expect(spelled("const f = (s: 'home' | 'shell'): void => {};")).toBe(1);
    expect(
      spelled("const rows = [['home', 1]] as const satisfies readonly ['home' | 'shell'][];"),
    ).toBe(1);
    // A narrowing of something else than the one type is a second vocabulary.
    expect(spelled("type A = Extract<PaletteSurface, 'home' | 'standalone-chat'>;")).toBe(1);
    expect(spelled("type A = Exclude<Foo, 'shell' | 'home'>;")).toBe(1);
  });

  it('allows the narrowings of the one type, and the unions that are not surfaces', () => {
    const spelled = (text: string): number => surfaceUnionsIn('x.ts', text).length;
    expect(spelled("type A = Extract<Surface, 'home' | 'standalone-chat'>;")).toBe(0);
    expect(spelled("type A = Exclude<Surface, 'shell'>;")).toBe(0);
    expect(spelled("type A = Exclude<Surface, 'shell' | 'home'>;")).toBe(0);
    expect(spelled("type A = Extract<Surface, 'home' | 'standalone-chat'> | undefined;")).toBe(0);
    // One surface beside words that are not surfaces: a palette class, a notice class, a sheet's scope, a Home mode.
    expect(spelled("type A = 'home' | 'chat';")).toBe(0);
    expect(spelled("type A = 'shell' | 'tui';")).toBe(0);
    expect(spelled("type A = 'chat' | 'project';")).toBe(0);
    expect(spelled("type A = 'home' | 'chat' | undefined;")).toBe(0);
    // Values are not types: a comparison or a list names surfaces without making a second type of them.
    expect(spelled("const s = x === 'home' || x === 'shell'; const l = ['home', 'shell'];")).toBe(
      0,
    );
    // A comment that mentions a union is not a union.
    expect(
      spelled("// type A = 'home' | 'shell'\n/* 'home-chat' | 'home' */\ntype B = string;"),
    ).toBe(0);
  });

  it('is held by every non-test source of the CLI', () => {
    const spelled: string[] = [];
    for (const full of sourceFiles(SRC)) {
      const file = relative(SRC, full).split(sep).join('/');
      if (file === SURFACE_FILE) continue;
      spelled.push(...surfaceUnionsIn(file, readFileSync(full, 'utf8')));
    }
    expect(
      spelled,
      'a union of surfaces outside render/surface.ts: write Extract<Surface, …> or Exclude<Surface, …> instead',
    ).toEqual([]);
  });

  it('is where the one type is declared, and the declaration is the only spelling of it', () => {
    const text = readFileSync(join(SRC, SURFACE_FILE), 'utf8');
    expect(surfaceUnionsIn(SURFACE_FILE, text)).toEqual([
      expect.stringContaining("'shell' | 'home' | 'home-chat' | 'standalone-chat'"),
    ]);
  });
});
