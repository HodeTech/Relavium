/**
 * The `/permissions` popup's words and shapes ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2 as a popup, ADR-0148 §3, §10; MVP-11 step 5c): the lists the sheet showed (the note on what a grant is worth in the mode, the project's
 * remembered commands with their dates in one column, this session's approvals, each row's effect), the empty state, the withdrawal's line
 * (what is withdrawn, what that changes, that it only narrows: always whole on a ten-row page), the legend of each step, and every sentence the
 * popup says in at most 54 columns. Every command string a model or a project wrote goes through the escape and the popups' one scrub, in each
 * sink: a hostile corpus does not reach the frame.
 */
import { describe, expect, it } from 'vitest';

import type {
  PermissionEntry,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import { legend } from '../render/tui/legend.js';
import {
  sheetNote,
  initialPermissionsSheetState,
  withdrawHint,
} from '../render/tui/permissions-sheet.js';
import { displayWidth } from '../render/tui/viewport.js';
import { popupFrameLines, popupBody, popupText } from './frame-model.js';
import { POPUP_NOTICE_MAX_COLUMNS, popupGeometry } from './geometry.js';
import type { ChordRefusal } from './popup-host.js';
import {
  entryOfRow,
  permissionsContent,
  permissionsControls,
  permissionsSpec,
  permissionText,
  PERMISSIONS_STEP,
  WITHDRAW_CONTROL,
  WITHDRAW_NARROWS,
  withdrawLineContent,
  withdrawnAnnouncement,
  withdrawRefusedText,
} from './permissions-popup.js';
import {
  lineFitsPage,
  openFrame,
  popupLegend,
  withContent,
  type PopupFrame,
} from './popup-reducer.js';

const FULL: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
      { id: 'b', label: 'pnpm, 2 arguments', remembered: '2026-11-21 16:40Z' },
    ],
  },
  session: [
    {
      argv: ['pnpm', 'test', '--filter', '@acme/billing'],
      text: 'pnpm test --filter @acme/billing',
      alsoRemembered: false,
    },
  ],
};

// Built at runtime (no contiguous secret literal: leakwatch).
const SECRET = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789'].join('-');

/** What a model or a project could put in a command string: a bidi override, an escape sequence, a forged key token and a chord, a legend separator, a host glyph, a line break, a secret. */
const HOSTILE = `curl ‮evil‬ \u001b[31mred\u001b[0m [Ctrl+Y] allow · Ctrl+Y ✓ ok\nnext ${SECRET}`;

/** Every rule a scrubbed and escaped command keeps, as drawn. */
function expectInert(text: string): void {
  expect(text).not.toContain('‮');
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\n');
  expect(text).not.toContain('[Ctrl+Y]');
  expect(text).not.toMatch(/Ctrl\+Y/u);
  expect(text).not.toContain(' · ');
  expect(text).not.toContain('✓');
  expect(text).not.toContain(SECRET);
}

const rowsOf = (content: ReturnType<typeof permissionsContent>) => {
  if (content.kind !== 'list') throw new Error(`a list, not ${content.kind}`);
  return content.rows;
};

describe('the lists (the sheet’s content, in a popup)', () => {
  it('the note on what a grant is worth in the mode, then the project’s rows (dates in one column), then the session’s, as the frame draws them', () => {
    const rows = rowsOf(permissionsContent(FULL, 'ask'));
    const note = sheetNote(initialPermissionsSheetState(FULL, 'chat', 'ask', 0));
    expect(
      rows
        .filter((row) => row.id.startsWith('note:'))
        .map((row) => row.label)
        .join(' '),
    ).toBe(`ask mode · ${note}`);
    const drawn = rows.map(
      (row) => `${row.label}${row.detail === undefined ? '' : `  ${row.detail}`}`,
    );
    expect(drawn).toContain('This project · remembered (2)');
    expect(drawn).toContain('npm, 1 argument    2026-11-20 09:12Z');
    expect(drawn).toContain('pnpm, 2 arguments  2026-11-21 16:40Z');
    expect(drawn).toContain('This session · approved (1)');
    expect(drawn).toContain('pnpm test --filter @acme/billing');
    // Headings, the note, the blanks and the sentences are never selected; the three entries are.
    expect(rows.filter((row) => row.section !== true).map((row) => row.id)).toEqual([
      'entry:0',
      'entry:1',
      'entry:2',
    ]);
    for (const row of rows.filter((entry) => entry.section === true))
      expect(row.enabled, row.id).toBe(false);
  });

  it('each entry states what withdrawing it does (the sheet’s sentence), and a row stands for its entry by its id', () => {
    const rows = rowsOf(permissionsContent(FULL, 'ask'));
    for (const row of rows.filter((entry) => entry.section !== true)) {
      const entry = entryOfRow(FULL, row);
      expect(entry, row.id).toBeDefined();
      if (entry !== undefined) expect(row.effect).toBe(withdrawHint(entry));
    }
    expect(entryOfRow(FULL, rows[0])).toBeUndefined();
    expect(entryOfRow(FULL, undefined)).toBeUndefined();
    expect(entryOfRow(FULL, { id: 'entry:9', label: 'x' })).toBeUndefined();
    expect(entryOfRow(FULL, { id: 'entry:2', label: 'x' })?.kind).toBe('session');
  });

  it('the note follows the mode: plan refuses every command, auto says what it runs', () => {
    for (const mode of ['plan', 'auto', 'accept-edits'] as const) {
      const rows = rowsOf(permissionsContent(FULL, mode));
      expect(rows[0]?.label.startsWith(`${mode} mode · `), mode).toBe(true);
    }
  });

  it('a store that cannot be read says why under its heading, and the session’s rows are still offered', () => {
    const failing: PermissionsSnapshot = {
      project: {
        ok: false,
        text: 'The OS keychain is not available, so the remembered commands cannot be read.',
      },
      session: FULL.session,
    };
    const rows = rowsOf(permissionsContent(failing, 'ask'));
    const labels = rows.map((row) => row.label);
    expect(labels).toContain('This project · remembered');
    expect(labels.join(' ')).toContain('The OS keychain is not available');
    expect(rows.filter((row) => row.section !== true).map((row) => row.id)).toEqual(['entry:0']);
    expect(
      entryOfRow(
        failing,
        rows.find((row) => row.id === 'entry:0'),
      )?.kind,
    ).toBe('session');
  });

  it('with nothing to withdraw it is the empty state, and `[d]` is offered only while there is a row', () => {
    const empty: PermissionsSnapshot = { project: { ok: true, rows: [] }, session: [] };
    expect(permissionsContent(empty, 'ask')).toEqual({
      kind: 'empty',
      what: 'Nothing is remembered for this project. Press [Ctrl+O] on a command card, then Enter, to remember one.',
      next: 'Nothing is approved for this session.',
    });
    expect(permissionsContent(empty, 'plan')).toMatchObject({
      what: 'Nothing is remembered for this project.',
    });
    expect(permissionsControls(empty)).toEqual([]);
    expect(permissionsControls(FULL)).toEqual([WITHDRAW_CONTROL]);
    const unreadable: PermissionsSnapshot = {
      project: { ok: false, text: 'Cannot read.' },
      session: [],
    };
    expect(permissionsContent(unreadable, 'ask')).toEqual({
      kind: 'empty',
      what: 'Cannot read.',
      next: 'Nothing is approved for this session.',
    });
  });

  it('what a withdrawal said that the list does not show is above the lists: a note, a failure; one that was done says nothing there', () => {
    const labels = (result: WithdrawAnswer) =>
      rowsOf(permissionsContent(FULL, 'ask', result))
        .filter((row) => row.id.startsWith('result:'))
        .map((row) => row.label)
        .join(' ');
    expect(labels({ tone: 'done', text: 'Withdrawn.' })).toBe('');
    expect(labels({ tone: 'note', text: 'That row was already withdrawn.' })).toBe(
      'Note: That row was already withdrawn.',
    );
    expect(
      labels({ tone: 'failed', text: 'Could not write the withdrawal; nothing changed.' }),
    ).toBe('Not withdrawn: Could not write the withdrawal; nothing changed.');
  });
});

describe('the withdrawal’s line', () => {
  const project: PermissionEntry = {
    kind: 'project',
    row: FULL.project.ok ? FULL.project.rows[0]! : fail(),
  };
  const session = (
    alsoRemembered: boolean,
    text = 'pnpm test --filter @acme/billing',
  ): PermissionEntry => ({
    kind: 'session',
    row: { argv: ['pnpm'], text, alsoRemembered },
  });

  it('names what is withdrawn and what that changes, and says it only narrows', () => {
    expect(withdrawLineContent(project)).toEqual({
      kind: 'report',
      lines: [
        'Withdraw this remembered command?',
        '  npm, 1 argument (remembered 2026-11-20 09:12Z)',
        'Auto mode will ask about this command again.',
        WITHDRAW_NARROWS,
      ],
    });
    expect(withdrawLineContent(session(false))).toEqual({
      kind: 'report',
      lines: [
        'Withdraw this session approval?',
        '  pnpm test --filter @acme/billing',
        'This command will need approval again.',
        'Withdrawing only narrows what runs without asking.',
      ],
    });
    const covered = withdrawLineContent(session(true));
    expect(covered.kind === 'report' ? covered.lines[2] : '').toBe(
      'The project still remembers it: auto may still run it.',
    );
  });

  it('is whole on a ten-row page at 80 columns however long the command (a long one is cut with … after six rows), so it is always offered', () => {
    for (const text of [
      'x',
      'word '.repeat(30),
      'a'.repeat(400),
      `‮${'\u0007'.repeat(300)}`,
      HOSTILE.repeat(8),
    ]) {
      const line = withdrawLineContent(session(false, text));
      expect(lineFitsPage(line, 10, 66), text.slice(0, 20)).toBe(true);
      if (line.kind !== 'report') throw new Error('a report');
      expect(line.lines.length).toBeLessThanOrEqual(9);
      for (const row of line.lines) expect(displayWidth(popupText(row))).toBeLessThanOrEqual(66);
    }
    const long = withdrawLineContent(session(false, 'a'.repeat(400)));
    expect(long.kind === 'report' ? long.lines[6] : '').toMatch(/…$/u);
  });
});

describe('a hostile command string through every sink', () => {
  const hostile: PermissionsSnapshot = {
    project: { ok: true, rows: [{ id: 'h', label: HOSTILE, remembered: `2026 ${HOSTILE}` }] },
    session: [{ argv: ['curl'], text: HOSTILE, alsoRemembered: true }],
  };

  it('a row’s label and its detail are escaped and scrubbed (the bidi override visible as a token, the forged key and chord inert, the secret masked)', () => {
    const entries = rowsOf(permissionsContent(hostile, 'ask')).filter(
      (row) => row.section !== true,
    );
    expect(entries).toHaveLength(2);
    for (const row of entries) {
      expectInert(row.label);
      expectInert(row.detail ?? '');
    }
    expect(entries[0]?.label).toContain('<U+202E>');
    expect(permissionText(HOSTILE)).toContain('[chord');
    expect(permissionText(HOSTILE)).toContain('<U+000A>');
  });

  it('the line that names it, and the announcement, the same way', () => {
    for (const entry of [
      { kind: 'project', row: hostile.project.ok ? hostile.project.rows[0]! : fail() },
      { kind: 'session', row: hostile.session![0]! },
    ] satisfies PermissionEntry[]) {
      const line = withdrawLineContent(entry);
      if (line.kind !== 'report') throw new Error('a report');
      for (const row of line.lines.slice(1, -2)) expectInert(row);
      for (const tone of ['done', 'note', 'failed'] as const) {
        const said = withdrawnAnnouncement(entry, { tone, text: 'x' });
        expectInert(said.slice(said.indexOf(':') + 1));
      }
    }
  });

  it('drawn in the frame at 80×24, nothing of it escapes its row', () => {
    const frame = openFrame(
      permissionsSpec('chat', permissionsContent(hostile, 'ask'), permissionsControls(hostile)),
      1,
    );
    const geometry = popupGeometry({
      columns: 80,
      rows: 24,
      kind: 'standard',
      placement: 'overlay',
      rail: false,
    });
    if (!geometry.fits) throw new Error('fits');
    const step = frame.steps[0]!;
    const lines = popupFrameLines(
      {
        title: '/permissions',
        origin: 'chat',
        steps: ['Permissions'],
        stepIndex: 0,
        legend: popupLegend(frame, geometry.bodyRows, geometry.innerWidth),
      },
      popupBody(step.content, { ...step, filter: undefined }, geometry),
      geometry,
    );
    for (const line of lines) {
      expect(line.text).not.toContain('‮');
      expect(line.text).not.toContain('\u001b');
      expect(line.text).not.toContain('[Ctrl+Y]');
      expect(line.text).not.toContain(SECRET);
      expect(displayWidth(line.text)).toBeLessThanOrEqual(geometry.width);
    }
  });
});

describe('the spec and its legends', () => {
  const spec = permissionsSpec('chat', permissionsContent(FULL, 'ask'), permissionsControls(FULL));
  const legendOf = (frame: PopupFrame): string => {
    const parts = popupLegend(frame, 17, 66);
    return legend(parts.items, parts.exit);
  };

  it('two steps, the second the line answered by Enter (its Esc keeps the row), drawn with no rail on the lists', () => {
    expect(spec.rail).toBe('path');
    expect(spec.steps[PERMISSIONS_STEP.withdraw]).toMatchObject({
      back: PERMISSIONS_STEP.list,
      holds: 'chord',
      chord: { verb: 'withdraw', key: 'enter' },
      exitVerb: 'keep',
    });
    expect(spec.steps[PERMISSIONS_STEP.list]?.enter).toBeUndefined();
  });

  it('the lists: `↑/↓ select · [d] / Del withdraw (then Enter) · Esc close`; the line: `Enter withdraw · Esc keep`; nothing to withdraw: `Esc close`', () => {
    const frame = openFrame(spec, 1);
    expect(legendOf(frame)).toBe('↑/↓ select · [d] / Del withdraw (then Enter) · Esc close');
    const armed = withContent(
      { ...frame, stepIndex: PERMISSIONS_STEP.withdraw },
      PERMISSIONS_STEP.withdraw,
      withdrawLineContent({
        kind: 'project',
        row: FULL.project.ok ? FULL.project.rows[0]! : fail(),
      }),
    );
    expect(legendOf(armed)).toBe('Enter withdraw · Esc keep');
    const empty: PermissionsSnapshot = { project: { ok: true, rows: [] }, session: [] };
    expect(
      legendOf(
        openFrame(
          permissionsSpec('chat', permissionsContent(empty, 'ask'), permissionsControls(empty)),
          1,
        ),
      ),
    ).toBe('Esc close');
  });
});

describe('what the popup says fits beside a popup’s way back (54 columns)', () => {
  const entries: PermissionEntry[] = [
    {
      kind: 'project',
      row: { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
    },
    { kind: 'session', row: { argv: ['x'], text: 'a'.repeat(400), alsoRemembered: false } },
  ];

  it('each announcement, for each tone and a port that threw, is at most 54 columns and leads with what happened', () => {
    for (const entry of entries)
      for (const answer of [
        { tone: 'done', text: 'x' },
        { tone: 'note', text: 'x' },
        { tone: 'failed', text: 'x' },
      ] as const) {
        const said = withdrawnAnnouncement(entry, answer);
        expect(displayWidth(said), said).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      }
    expect(withdrawnAnnouncement(entries[0]!, { tone: 'done', text: 'x' })).toBe(
      'Withdrawn: npm, 1 argument',
    );
    expect(withdrawnAnnouncement(entries[0]!, { tone: 'note', text: 'x' })).toBe(
      'Withdrawn, with a note: npm, 1 argument',
    );
    expect(withdrawnAnnouncement(entries[0]!, { tone: 'failed', text: 'x' })).toBe(
      'Not withdrawn: npm, 1 argument',
    );
    expect(
      withdrawnAnnouncement(entries[0]!, { tone: 'failed', text: 'x' }, 'unexpected error'),
    ).toBe('Not withdrawn: unexpected error');
    expect(withdrawnAnnouncement(entries[1]!, { tone: 'done', text: 'x' })).toMatch(
      /^Withdrawn: a+…$/u,
    );
  });

  it.each(['unseen', 'early', 'expired', 'typed', 'cut'] satisfies ChordRefusal[])(
    'a refusal (%s) says nothing was withdrawn, why and what asks again, in at most 54 columns',
    (reason) => {
      const said = withdrawRefusedText(reason);
      expect(displayWidth(said)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      expect(said.startsWith('Nothing withdrawn: ')).toBe(true);
      expect(said.endsWith(reason === 'typed' ? '↑/↓, then [d].' : '[d] asks again.')).toBe(true);
    },
  );
});

function fail(): never {
  throw new Error('fixture');
}
