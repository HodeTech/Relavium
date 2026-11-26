/**
 * The two bounds of the `/run` popup's own sentences, at their edges (MVP-11 unit 6, round 1: test gaps R15, R17). A notification is drawn whole when it
 * takes exactly {@link POPUP_NOTICE_MAX_COLUMNS} columns and gives way to its short form at one column more; a workflow's label (a word a project wrote)
 * is named whole at exactly 60 characters and is cut to 59 and the ellipsis at 61.
 */
import { describe, expect, it } from 'vitest';

import { POPUP_NOTICE_MAX_COLUMNS } from '../popups/geometry.js';
import { displayWidth } from '../render/tui/viewport.js';
import { launchNotOffered, startedNotice } from './run-launch.js';

const RUN = 'abcdef0123456789';
const SHORT_RUN = 'abcdef01';
/** The label's own limit (`LABEL_LIMIT` in `run-launch.ts`: the characters a workflow is named by on the picker, the confirmation and the notices). */
const LABEL_LIMIT = 60;
/** The columns a started notice spends besides the label: `Started `, ` · run ` and the short run id. */
const STARTED_FIXED = 'Started '.length + ' · run '.length + SHORT_RUN.length;

describe('the started notice at the edge of its columns (R15)', () => {
  it('a notice of exactly the notification’s columns is drawn whole', () => {
    const label = 'x'.repeat(POPUP_NOTICE_MAX_COLUMNS - STARTED_FIXED);
    const whole = startedNotice(label, RUN);
    expect(displayWidth(whole)).toBe(POPUP_NOTICE_MAX_COLUMNS);
    expect(whole).toBe(`Started ${label} · run ${SHORT_RUN}`);
  });

  it('a label one column longer gives way to the run alone', () => {
    const label = 'x'.repeat(POPUP_NOTICE_MAX_COLUMNS - STARTED_FIXED + 1);
    expect(startedNotice(label, RUN)).toBe(`Started run ${SHORT_RUN}`);
  });

  it('a wide character counts by its columns, not its characters', () => {
    // A wide character takes two columns: ten of them and eleven narrow ones are 31 columns (21 characters), the most the notice holds.
    const fits = `${'界'.repeat(10)}${'x'.repeat(11)}`; // 31 columns, 21 characters
    expect(displayWidth(fits)).toBe(31);
    expect(startedNotice(fits, RUN)).toBe(`Started ${fits} · run ${SHORT_RUN}`);
    const over = `${'界'.repeat(10)}${'x'.repeat(12)}`; // 32 columns
    expect(startedNotice(over, RUN)).toBe(`Started run ${SHORT_RUN}`);
  });
});

describe('a workflow named in a sentence at the edge of its limit (R17)', () => {
  it('a slug of exactly the label limit is named whole', () => {
    expect(launchNotOffered('s'.repeat(LABEL_LIMIT))).toBe(
      `Not started. ${'s'.repeat(LABEL_LIMIT)} is not a valid workflow of this project.`,
    );
  });

  it('a slug one character longer is cut to the limit, the ellipsis its last character', () => {
    expect(launchNotOffered('s'.repeat(LABEL_LIMIT + 1))).toBe(
      `Not started. ${'s'.repeat(LABEL_LIMIT - 1)}… is not a valid workflow of this project.`,
    );
  });
});
