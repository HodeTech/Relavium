/**
 * The words the run pages use for what is absent ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): the constants of `absence.ts` are compared with the reference's "Words for what is absent" section in BOTH directions, so
 * a sentence changed in the code and not in the reference (or the other way round) fails here, and a row added to either side has no
 * counterpart to hide behind. The reference is read from `docs/reference/cli/home.md`; nothing is copied into this file.
 */
import { describe, expect, it } from 'vitest';

import { absenceText, type NodeRowStatus } from '../history/run-detail-model.js';
import { readAbsenceReference } from '../test-support.js';
import {
  ABSENCE_SENTENCES,
  DID_NOT_RUN,
  DURATION_PLACEHOLDER,
  NOT_YET_RUN,
  TOOL_OUTCOME_TEMPLATES,
  toolFailedAfter,
  toolOkIn,
} from './absence.js';

const sorted = (words: readonly string[]): string[] =>
  [...words].sort((a, b) => a.localeCompare(b));

describe('the absence sentences are the ones the reference lists', () => {
  it('lists exactly the sentences of the module: none missing from the reference, none only in the reference', () => {
    const reference = readAbsenceReference();
    expect(reference.sentences.length, 'the reference table was read').toBeGreaterThan(0);
    expect(sorted(reference.sentences)).toEqual(sorted(Object.values(ABSENCE_SENTENCES)));
  });

  it('says each sentence once: no two situations share a word, in the module or in the reference', () => {
    const reference = readAbsenceReference();
    expect(new Set(reference.sentences).size).toBe(reference.sentences.length);
    expect(new Set(Object.values(ABSENCE_SENTENCES)).size).toBe(
      Object.values(ABSENCE_SENTENCES).length,
    );
  });

  it('lists exactly the tool outcome words of the module', () => {
    const reference = readAbsenceReference();
    expect(reference.toolOutcomes.length, 'the outcome table was read').toBeGreaterThan(0);
    expect(sorted(reference.toolOutcomes)).toEqual(sorted(Object.values(TOOL_OUTCOME_TEMPLATES)));
  });

  it('puts the call`s measured duration where the placeholder is, and nowhere else', () => {
    expect(toolOkIn('12ms')).toBe('ok in 12ms');
    expect(toolFailedAfter('340ms')).toBe('failed after 340ms');
    expect(TOOL_OUTCOME_TEMPLATES.okIn).toContain(DURATION_PLACEHOLDER);
    expect(TOOL_OUTCOME_TEMPLATES.failedAfter).toContain(DURATION_PLACEHOLDER);
    expect(toolOkIn('x')).not.toContain(DURATION_PLACEHOLDER);
  });

  it('is what the model says for every state of a row: only listed sentences, and a row that has not run says so', () => {
    const listed = new Set(readAbsenceReference().sentences);
    const statuses: readonly NodeRowStatus[] = [
      'pending',
      'running',
      'completed',
      'failed',
      'skipped',
      'stopped',
    ];
    for (const status of statuses)
      for (const finished of [true, false])
        expect(
          listed.has(absenceText(status, finished)),
          `${status} / finished ${String(finished)}`,
        ).toBe(true);
    expect(absenceText('pending', false)).toBe(NOT_YET_RUN);
    expect(absenceText('pending', true)).toBe(DID_NOT_RUN);
  });
});
