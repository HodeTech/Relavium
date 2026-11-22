/**
 * The Home's notice channel for a hosted run ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §3): bounded in entries and in width, sanitized line by line, and read only through frozen snapshots.
 */
import { describe, expect, it } from 'vitest';

import { RUN_NOTICE_CAPACITY, RUN_NOTICE_WIDTH, RunNotices } from './run-notices.js';

function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

describe('RunNotices', () => {
  it('keeps one entry per line, drops blank lines, and reads oldest first', () => {
    const notices = new RunNotices();
    notices.push('warning: first\nwarning: second\n');
    notices.push('\n   \n');
    notices.push('warning: third');
    expect(notices.snapshot()).toEqual(['warning: first', 'warning: second', 'warning: third']);
    expect(notices.size).toBe(3);
  });

  describe('bounded', () => {
    it('cuts an entry that is wider than the fixed width, ending in an ellipsis', () => {
      const notices = new RunNotices();
      notices.push('x'.repeat(RUN_NOTICE_WIDTH + 500));
      const [entry] = notices.snapshot();
      expect(Array.from(entry ?? '')).toHaveLength(RUN_NOTICE_WIDTH);
      expect(entry?.endsWith('…')).toBe(true);
      expect(entry?.startsWith('x'.repeat(RUN_NOTICE_WIDTH - 1))).toBe(true);
    });

    it('keeps an entry of exactly the width whole', () => {
      const notices = new RunNotices();
      notices.push('y'.repeat(RUN_NOTICE_WIDTH));
      expect(notices.snapshot()).toEqual(['y'.repeat(RUN_NOTICE_WIDTH)]);
    });

    it('never cuts a surrogate pair in half', () => {
      const notices = new RunNotices();
      // Each emoji is one code point and two UTF-16 units: a unit-based cut would land inside one.
      notices.push('😀'.repeat(RUN_NOTICE_WIDTH + 10));
      const [entry] = notices.snapshot();
      expect(Array.from(entry ?? '')).toHaveLength(RUN_NOTICE_WIDTH);
      expect(entry).toBe('😀'.repeat(RUN_NOTICE_WIDTH - 1) + '…');
    });

    it('evicts the oldest entries first once the ring is full', () => {
      const notices = new RunNotices();
      const total = RUN_NOTICE_CAPACITY + 7;
      for (let n = 0; n < total; n += 1) notices.push(`line ${String(n)}\n`);
      const held = notices.snapshot();
      expect(held).toHaveLength(RUN_NOTICE_CAPACITY);
      expect(held[0]).toBe(`line ${String(total - RUN_NOTICE_CAPACITY)}`);
      expect(held.at(-1)).toBe(`line ${String(total - 1)}`);
    });

    it('keeps only the newest lines of one write that is larger than the ring', () => {
      const notices = new RunNotices();
      const burst = Array.from({ length: RUN_NOTICE_CAPACITY * 3 }, (_, n) => `burst ${String(n)}`);
      notices.push(burst.join('\n'));
      const held = notices.snapshot();
      expect(held).toHaveLength(RUN_NOTICE_CAPACITY);
      expect(held.at(-1)).toBe(`burst ${String(burst.length - 1)}`);
    });

    it('looks at a flood only from its end, and never shows its cut as an entry', () => {
      const notices = new RunNotices();
      const flood = 'a'.repeat(100_000) + '\nthe newest line\n';
      notices.push(flood);
      expect(notices.snapshot().at(-1)).toBe('the newest line');
      // The partial line the cut left at the front was dropped, not kept as a notice.
      expect(notices.snapshot()).toEqual(['the newest line']);
    });
  });

  describe('sanitized', () => {
    it('strips every terminal control and escape sequence from a line', () => {
      const notices = new RunNotices();
      notices.push('ok\x1b[31m red \x1b]0;title\x07 end\x00\x07\r\n');
      notices.push('bidi ‮ reversed ⁦ isolate\n');
      for (const entry of notices.snapshot())
        expect(hasControl(entry), JSON.stringify(entry)).toBe(false);
      expect(notices.snapshot()[0]).toContain('ok');
      expect(notices.snapshot()[0]).not.toContain('\x1b');
    });

    it('collapses a tab into a space and cannot be made to forge a second line', () => {
      const notices = new RunNotices();
      notices.push('forged\tcolumn');
      expect(notices.snapshot()).toEqual(['forged column']);
    });

    it('sanitizes before it cuts, so a cut cannot leave half an escape sequence', () => {
      const notices = new RunNotices();
      // An escape sequence that would straddle the width if it were cut first.
      notices.push('z'.repeat(RUN_NOTICE_WIDTH - 3) + '\x1b[1;31;42mTAIL');
      const [entry] = notices.snapshot();
      expect(hasControl(entry ?? '')).toBe(false);
      expect(entry).not.toContain('[1;31');
    });
  });

  describe('read-only snapshots', () => {
    it('hands out a frozen copy that later writes and clears do not change', () => {
      const notices = new RunNotices();
      notices.push('before');
      const earlier = notices.snapshot();
      expect(Object.isFrozen(earlier)).toBe(true);
      notices.push('after');
      expect(earlier).toEqual(['before']);
      notices.clear();
      expect(earlier).toEqual(['before']);
      expect(notices.snapshot()).toEqual([]);
    });

    it('rejects a write through a snapshot', () => {
      const notices = new RunNotices();
      notices.push('kept');
      const snapshot = notices.snapshot();
      expect(() => Reflect.apply(Array.prototype.push, snapshot, ['forged'])).toThrow(TypeError);
      expect(notices.snapshot()).toEqual(['kept']);
    });
  });

  it('clear() forgets everything and the ring is usable afterwards', () => {
    const notices = new RunNotices();
    for (let n = 0; n < RUN_NOTICE_CAPACITY + 3; n += 1) notices.push(`n${String(n)}`);
    notices.clear();
    expect(notices.size).toBe(0);
    notices.push('fresh');
    expect(notices.snapshot()).toEqual(['fresh']);
  });
});
