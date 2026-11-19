import type { ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { createReviewDocument } from '../render/tui/tool-review-projection.js';
import { fullChrome, fullAnswerRows, fullWarnings } from '../render/tui/tool-review-screen.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import {
  acknowledgeToolReview,
  initialToolReview,
  inspectionPending,
  toolReviewPage,
} from '../render/tui/tool-review-model.js';
import type { CommandCardFacts } from './command-facts.js';

/**
 * How a command is projected for review (ADR-0118 §1): one row per argument, the exact bounds of what can be shown, and every
 * masked span a requirement. The projection is the CLI's, the preview is the core's; this is where the two meet.
 */
const bare = (argv: readonly string[]): ToolPreview => ({
  kind: 'operation',
  target: argv.join(' '),
  fields: argv.map((value) => ({ name: '', value })),
});
const FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};

describe('a command is one row per argument', () => {
  it('a field with no name is a bare value: one source line, no name line above it', () => {
    const document = createReviewDocument(bare(['git', 'status', '-s']), { requireAllMasks: true });
    expect(document.valid).toBe(true);
    expect(document.lines.map((line) => line.label)).toEqual([
      'target',
      'field value',
      'field value',
      'field value',
    ]);
  });

  it('a named field keeps both of its lines, as every other tool’s fields do', () => {
    const document = createReviewDocument({
      kind: 'operation',
      target: 'api.example.com',
      fields: [{ name: 'method', value: 'GET' }],
    });
    expect(document.lines.map((line) => line.label)).toEqual([
      'target',
      'field name',
      'field value',
    ]);
  });
});

describe('what a command card can show (the bounds of the review document)', () => {
  const longest = (count: number, size = 1) =>
    bare(['x', ...Array.from({ length: count }, () => 'a'.repeat(size))]);

  it('64 elements (the program and 63 arguments) are shown, 65 are not', () => {
    expect(
      createReviewDocument(bare(Array.from({ length: 64 }, () => 'a')), { requireAllMasks: true })
        .valid,
    ).toBe(true);
    expect(
      createReviewDocument(bare(Array.from({ length: 65 }, () => 'a')), { requireAllMasks: true })
        .valid,
    ).toBe(false);
    expect(longest(63).fields).toHaveLength(64);
  });

  it('an argument or a line of 4,096 characters is shown, 4,097 is not', () => {
    const at = (size: number): ToolPreview => ({
      kind: 'operation',
      target: 'x',
      fields: [{ name: '', value: 'a'.repeat(size) }],
    });
    expect(createReviewDocument(at(4096), { requireAllMasks: true }).valid).toBe(true);
    expect(createReviewDocument(at(4097), { requireAllMasks: true }).valid).toBe(false);
    expect(
      createReviewDocument(
        { kind: 'operation', target: 'a'.repeat(4096), fields: [] },
        { requireAllMasks: true },
      ).valid,
    ).toBe(true);
    expect(
      createReviewDocument(
        { kind: 'operation', target: 'a'.repeat(4097), fields: [] },
        { requireAllMasks: true },
      ).valid,
    ).toBe(false);
  });
});

describe('every masked span of a command is a requirement (security sitting, MVP-4 step 4 round 1)', () => {
  const SECRET = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(6);
  const withSecret = (argv: readonly string[]) => bare(argv);

  it('a credential-shaped argument must be revealed on a command, and need not be on a file card', () => {
    const preview = withSecret(['curl', '-H', `Authorization: Bearer ${SECRET}`]);
    const command = createReviewDocument(preview, { requireAllMasks: true });
    expect(command.masks.length).toBeGreaterThan(0);
    expect(command.required.length).toBe(command.masks.length);
    const plain = createReviewDocument(preview);
    expect(plain.required.length, 'the file-card rule is unchanged').toBeLessThan(
      plain.masks.length,
    );
  });

  it('a program that is nothing but a masked token is a requirement too', () => {
    const document = createReviewDocument(withSecret([`./${SECRET}`]), { requireAllMasks: true });
    expect(document.required.length).toBeGreaterThan(0);
    const review = initialToolReview('approval', 'call', document, FACTS);
    expect(inspectionPending(review).masks).toBe(document.required.length);
  });

  it('while a mask is unrevealed the card is locked: Allow, Session and Remember are all withheld', () => {
    const document = createReviewDocument(withSecret(['curl', `--token=${SECRET}`]), {
      requireAllMasks: true,
    });
    const review = initialToolReview('approval', 'call', document, FACTS);
    const page = toolReviewPage(review, 80, 24);
    expect(page).toBeDefined();
    expect(
      inspectionPending(acknowledgeToolReview(review, page!), page?.requiredTarget).masks,
    ).toBeGreaterThan(0);
  });

  it('the masks of the same document are cached apart from the file-card rule, so one never answers for the other', () => {
    const argv = ['curl', `--token=${SECRET}`];
    // Only an immutable preview is cached, exactly as the engine's frozen previews are.
    const preview: ToolPreview = Object.freeze({
      kind: 'operation',
      target: argv.join(' '),
      fields: Object.freeze(argv.map((value) => Object.freeze({ name: '', value }))),
    });
    const strict = createReviewDocument(preview, { requireAllMasks: true });
    const lax = createReviewDocument(preview);
    expect(strict).not.toBe(lax);
    expect(createReviewDocument(preview, { requireAllMasks: true })).toBe(strict);
  });
});

describe('the full view of a command carries its facts and the Remember question', () => {
  it('opens with the standing and the directory, then any warning, as the card does', () => {
    const rows = fullWarnings({
      kind: 'approval',
      document: createReviewDocument(bare(['npm', 'test']), { requireAllMasks: true }),
      pending: { target: false, masks: 0 },
      columns: 80,
      commandFacts: { ...FACTS, runsCode: true, protectedPath: true },
    });
    // One row while the directory still has room to say where it is.
    expect(rows[0]).toBe('Standing: not pre-approved · Runs in: /work/project');
    expect(rows.join(' ')).toContain('Runs code');
    expect(rows.join(' ')).toContain('Names a protected path');
  });

  it('a details screen, and an approval of any other call, have no command rows', () => {
    const document = createReviewDocument(bare(['npm', 'test']));
    expect(
      fullWarnings({
        kind: 'details',
        document,
        pending: { target: false, masks: 0 },
        columns: 80,
        commandFacts: FACTS,
      }),
    ).toEqual([]);
    expect(
      fullWarnings({
        kind: 'approval',
        document,
        pending: { target: false, masks: 0 },
        columns: 80,
      }),
    ).toEqual([]);
  });

  it('while the Remember question is open its legend keeps the cancel row, as the session question does', () => {
    const keys = {
      inspected: true,
      cacheable: true,
      scope: 's',
      command: true,
      remember: true,
      confirmRemember: true,
    };
    expect(fullAnswerRows(keys)).toEqual([
      'Press Enter to allow this exact command now and remember it for this project',
      'Enter confirms · any other key cancels, allowing nothing · Esc stops the turn',
    ]);
    const chrome = fullChrome({
      kind: 'approval',
      title: 'Review',
      columns: 80,
      document: createReviewDocument(bare(['npm', 'test']), { requireAllMasks: true }),
      identity: [],
      hasTarget: true,
      pending: { target: false, masks: 0 },
      nav: { hasChanges: false, hasMasks: false, canCopy: false, revealed: false, numeric: false },
      keys,
      searching: false,
      commandFacts: FACTS,
    });
    expect(chrome.warnings[0]).toBe('Standing: not pre-approved · Runs in: /work/project');
    expect(chrome.answers).toEqual(fullAnswerRows(keys));
  });
});

describe('the transcript row of a command names the program only', () => {
  const REQUEST_PREVIEW: ToolPreview = bare([
    'curl',
    '-H',
    'Authorization: Bearer hunter2-token',
    'https://example.com',
  ]);

  it('the target of the tool row is the program; the arguments live in the details document', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.applyToolLiveEvent({ phase: 'started', callId: 'c1', toolId: 'run_command' });
    store.applyToolLiveEvent({
      phase: 'preview',
      callId: 'c1',
      toolId: 'run_command',
      preview: REQUEST_PREVIEW,
    });
    const display = store.getSnapshot().toolDisplays.get('c1');
    expect(display?.target).toBe('curl');
    expect(JSON.stringify(display?.target)).not.toContain('hunter2');
  });

  it('any other tool keeps its preview target', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.applyToolLiveEvent({ phase: 'started', callId: 'c2', toolId: 'read_file' });
    store.applyToolLiveEvent({
      phase: 'preview',
      callId: 'c2',
      toolId: 'read_file',
      preview: { kind: 'operation', target: 'src/app.ts', fields: [] },
    });
    expect(store.getSnapshot().toolDisplays.get('c2')?.target).toBe('src/app.ts');
  });
});

describe('a command card refused by the review is told so, in words that help', () => {
  const REQUEST: ToolApprovalRequest = {
    toolId: 'run_command',
    action: 'process',
    preview: { command: 'x' },
    argv: ['x'],
    commandAdmitted: false,
  };
  it('Deny of an unshowable command tells the model why, without the command', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    let answer: unknown;
    void store
      .requestApproval(
        REQUEST,
        true,
        undefined,
        { callId: 'c', preview: bare(Array.from({ length: 70 }, () => 'a')) },
        FACTS,
      )
      .then((value) => (answer = value));
    store.handleReviewInput('n', { ctrl: true });
    await Promise.resolve();
    expect(answer).toMatchObject({ outcome: 'reject' });
    expect(JSON.stringify(answer)).toContain('smaller commands');
    expect(JSON.stringify(answer)).not.toContain('"a"');
  });
});
