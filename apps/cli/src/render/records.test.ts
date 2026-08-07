import { describe, expect, it } from 'vitest';

import { captureIo, parseNdjson } from '../test-support.js';
import { writeRecordLines } from './records.js';

/**
 * The NDJSON record writer behind every read command's `--json` (`status`, `gate list`, `logs`, `chat list`,
 * `models`, `provider`). It carried model- and provider-controlled text through a bare `JSON.stringify`
 * (#W15-10) — the call-site half of the `stringifyJsonLine` unit tests in `sanitize.test.ts`.
 */
describe('writeRecordLines (#W15-10)', () => {
  it('escapes a bidi override carried by a record field', () => {
    const io = captureIo();
    writeRecordLines(io.io, [{ gateId: 'g1', message: 'approve \u202erm -rf /' }]);
    const line = io.out();
    expect(line).not.toContain('\u202e');
    expect(line).toContain('\\u202e');
  });

  it('stays lossless and one-record-per-line', () => {
    const io = captureIo();
    const records = [{ a: 'x\u202ey' }, { b: 2 }];
    writeRecordLines(io.io, records);
    // `parseNdjson` is the shared narrowing (it rejects a non-object line), so this also pins one record
    // per line — an escape that broke the framing would fail here before the equality check.
    expect(parseNdjson(io.out())).toEqual(records);
  });
});
