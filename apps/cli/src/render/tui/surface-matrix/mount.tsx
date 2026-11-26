import { Box, render, type DOMElement, type Instance } from 'ink';
import type { ReactElement } from 'react';

import { settleFrames } from '../harness-util.js';
import { OwnedTtyInput } from '../../../test-support.js';
import { FakeStdout, type ScreenCell } from './terminal.js';
import type { Variant } from './variants.js';

/**
 * One mounted tree over the fake terminal, as `driveHome` and `driveInk` mount it: the real `ink` `render()` (interactive, not debug,
 * `alternateScreen` for the full-screen renderer), so what the matrix reads is what a terminal would show after Ink's erase-and-rewrite
 * cycle, and the bytes that went to it.
 */
export interface InkMount {
  readonly stdout: FakeStdout;
  readonly stdin: OwnedTtyInput;
  readonly variant: Variant;
  /** The screen as a terminal shows it now (styling absent), after the pending render has been flushed by the caller. */
  frame: () => string[];
  /** The same rows with what each cell was drawn with (bold, dim, inverse, underline, colours), for a property about how the screen LOOKS. */
  cells: () => ScreenCell[][];
  /**
   * How many of the rows at the top of {@link InkMount.frame} Ink printed ONCE through `<Static>` (the inline renderer's scrollback: the chat's
   * header, its transcript lines). They are history: Ink never redraws or erases them, and in a real terminal they scroll away, so they are not
   * the live frame the height and the popup's rows are measured over. Only rows the tree marks `internal_static` count: a row the live frame draws
   * itself is live whatever it says, and so is every row a test appends to the terminal's bytes.
   */
  staticRows: () => number;
  /** Every byte written to the terminal since the mount, styling included. */
  raw: () => string;
  /** Write bytes to the terminal's input, as a keyboard does. */
  key: (bytes: string) => void;
  /** Let the pending render land: Ink's own flush (throttle timers, passive effects), then the frames the viewport needs. */
  settle: () => Promise<void>;
  /**
   * Poll until `predicate` holds, flushing Ink's render between checks (never a fixed sleep); `true` when it did. It does not throw: the
   * caller's own check then reports the frame it found.
   */
  until: (predicate: () => boolean, maxFlushes?: number) => Promise<boolean>;
  /** Replace the tree, as a state change that reaches the root does. */
  rerender: (tree: ReactElement) => void;
  /** Change the terminal's size and tell Ink, as a resize does. */
  resize: (cols: number, rows: number) => void;
  /** Ink's root node of the mounted tree (through a zero-size probe drawn first), for a property that reads the tree's layers. */
  root: () => DOMElement | undefined;
  unmount: () => void;
}

export interface MountOptions {
  /** A test-only hook on every chunk the terminal receives (the mutation tests break a property with it). */
  readonly tamper?: ((chunk: string) => string) | undefined;
}

/** The ceiling of a poll: Ink flushes in well under a millisecond here, so this is a bound on a defect, not a delay anything waits out. */
const MAX_FLUSHES = 400;

type TreeNode = DOMElement['childNodes'][number];

/** Whether a node of the tree holds a character that shows: a text node that is more than white space, or an element that holds one. */
function holdsVisibleText(node: TreeNode): boolean {
  return node.nodeName === '#text'
    ? node.nodeValue.trim() !== ''
    : node.childNodes.some(holdsVisibleText);
}

/**
 * The rows Ink prints through `<Static>` in the render that is being drawn now: the height of the root's `<Static>` node, whose children are
 * the items not printed yet (Ink drops them in the next commit, so a later read sees none). Ink prints nothing for static output that is one blank
 * row (`staticOutput === '\n'`: it cannot tell it from none), and neither does this count.
 */
export function printedStaticRows(root: DOMElement | undefined): number {
  const node = root?.staticNode;
  const height = node?.yogaNode?.getComputedHeight();
  if (node === undefined || height === undefined || !(height >= 1)) return 0;
  const rows = Math.round(height);
  return rows === 1 && !holdsVisibleText(node) ? 0 : rows;
}

export function mountInk(
  tree: ReactElement,
  variant: Variant,
  options: MountOptions = {},
): InkMount {
  const stdout = new FakeStdout(variant.size.cols, variant.size.rows, options.tamper);
  const stdin = new OwnedTtyInput();
  // A zero-size box drawn FIRST, so the tree's own last child stays last: its parent is Ink's root, which the overlay property walks. Its
  // `ref` is ONE function for the life of the mount: a new function per render would detach the probe (`null`) and attach it again in the
  // layout phase, after Ink has already drawn that commit, so the render that prints the `<Static>` rows would find no root to read.
  let probe: DOMElement | null = null;
  const attach = (node: DOMElement | null): void => {
    probe = node;
  };
  const probed = (body: ReactElement | null): ReactElement => (
    <>
      <Box ref={attach} width={0} height={0} />
      {body}
    </>
  );
  // The rows Ink printed through `<Static>` so far: the sum over every render that printed some (it prints a render's items once and drops
  // them, so the tree holds them only while that render is drawn).
  let printedRows = 0;
  const instance: Instance = render(probed(null), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    alternateScreen: variant.renderer === 'alt',
    // The cadence is not what the matrix measures; the smallest throttle keeps a poll from waiting on a timer.
    maxFps: 1000,
    onRender: () => {
      printedRows += printedStaticRows(probe?.parentNode);
    },
  });
  // The tree is mounted by the second render, not the first: the probe attaches in the first commit's layout phase, which is after Ink has
  // drawn it, so a tree mounted by the first render would print its `<Static>` rows (a seeded transcript, the header) before the probe could
  // find the root to count them in. The first render draws nothing (the probe is zero-sized; Ink writes no frame for an empty one).
  instance.rerender(probed(tree));
  let unmounted = false;
  const flush = async (): Promise<void> => {
    if (!unmounted) await instance.waitUntilRenderFlush();
  };
  const until = async (predicate: () => boolean, maxFlushes = MAX_FLUSHES): Promise<boolean> => {
    for (let i = 0; i < maxFlushes; i += 1) {
      if (predicate()) return true;
      await flush();
    }
    return predicate();
  };
  return {
    stdout,
    stdin,
    variant,
    frame: () => stdout.screen.lines(),
    cells: () => stdout.screen.cells(),
    staticRows: () => printedRows,
    raw: () => stdout.raw(),
    key: (bytes) => {
      stdin.push(bytes);
    },
    settle: async () => {
      await flush();
      await settleFrames();
      await flush();
    },
    until,
    rerender: (next) => {
      instance.rerender(probed(next));
    },
    resize: (cols, rows) => {
      stdout.resize(cols, rows);
    },
    root: () => probe?.parentNode,
    unmount: () => {
      if (unmounted) return;
      unmounted = true;
      instance.unmount();
      instance.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}
