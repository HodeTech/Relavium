import { describe, expect, it } from 'vitest';

import {
  appendAttachment,
  attachmentChip,
  buildOutbound,
  commandResultPreview,
  fileAttachmentWarning,
  MAX_PENDING_ATTACHMENTS,
  mentionMarker,
  mentionPresent,
  type PendingAttachment,
} from './attachments.js';
import { INJECT_MAX_CHARS } from './injection.js';

const file = (path: string, content = 'x'): PendingAttachment => ({
  kind: 'file',
  path,
  content,
  sizeBytes: content.length,
});
const cmd = (command: string, args: string[] = [], exitCode = 0): PendingAttachment => ({
  kind: 'command',
  cmd: { command, args },
  exitCode,
  stdout: 'OUT',
  stderr: '',
});

describe('@/! pending-attachment model (2.5.D chip redesign)', () => {
  it('mentionPresent matches a whitespace-bounded @path token, not a mid-word / substring @', () => {
    expect(mentionMarker('src/a.ts')).toBe('@src/a.ts');
    expect(mentionPresent('look at @src/a.ts please', 'src/a.ts')).toBe(true);
    expect(mentionPresent('@src/a.ts', 'src/a.ts')).toBe(true); // whole line
    expect(mentionPresent('email me@src/a.ts', 'src/a.ts')).toBe(false); // mid-word (preceded by 'e')
    expect(mentionPresent('see @src/a.tsx', 'src/a.ts')).toBe(false); // @src/a.ts is a prefix, not a token (followed by 'x')
    expect(mentionPresent('no marker here', 'src/a.ts')).toBe(false);
  });

  it('attachmentChip labels a file by @path and a command by !line (exit N)', () => {
    expect(attachmentChip(file('src/a.ts'))).toBe('@src/a.ts');
    expect(attachmentChip(cmd('git', ['status'], 0))).toBe('!git status (exit 0)');
    expect(attachmentChip(cmd('npm', ['test'], 1))).toBe('!npm test (exit 1)');
  });

  it('buildOutbound includes a FILE only when its marker is present; a COMMAND is always carried', () => {
    const attachments = [file('src/a.ts', 'export const x = 1;'), cmd('npm', ['test'], 0)];
    // The prose references the file marker → the file is included; the command is carried regardless.
    const out = buildOutbound('look at @src/a.ts', attachments);
    expect(out.consumed).toHaveLength(2);
    expect(out.message).toContain('look at @src/a.ts'); // prose preserved
    expect(out.message).toContain('<file'); // the file framed block appended
    expect(out.message).toContain('export const x = 1;'); // the file content (untrusted, framed)
    expect(out.message).toContain('<command'); // the command framed block appended
    expect(out.display).toBe('look at @src/a.ts [📎 !npm test (exit 0)]'); // compact: prose + carried-command note only

    // The user DELETED the file marker (prose no longer contains @src/a.ts) → the file is dropped; the command stays.
    const out2 = buildOutbound('never mind', attachments);
    expect(out2.consumed.map((c) => c.kind)).toEqual(['command']);
    expect(out2.message).not.toContain('<file');
    expect(out2.message).toContain('<command');
  });

  it('buildOutbound with no attachments returns the prose unchanged', () => {
    expect(buildOutbound('just a message', [])).toEqual({
      message: 'just a message',
      display: 'just a message',
      consumed: [],
    });
  });

  it('fileAttachmentWarning is honest — bounded-token count + a truncation note, not the raw size', () => {
    expect(fileAttachmentWarning('a.ts', 'small', 5)).toBeUndefined(); // under the warn threshold
    // A large-but-untruncated file (over the warn threshold, under the cap) warns on its real token count.
    const midBytes = 40 * 1024;
    const mid = fileAttachmentWarning('big.ts', 'y'.repeat(midBytes), midBytes);
    expect(mid).toContain('~10240 tokens'); // 40 KiB / 4
    expect(mid).not.toContain('truncated');
    // A file OVER the inject cap warns that it was TRUNCATED, with the bounded (not raw) token count.
    const hugeBytes = INJECT_MAX_CHARS * 4;
    const huge = fileAttachmentWarning('huge.ts', 'z'.repeat(hugeBytes), hugeBytes);
    expect(huge).toContain('truncated to fit');
    expect(huge).toContain(`~${INJECT_MAX_CHARS / 4} tokens`); // bounded count, NOT hugeBytes/4
  });

  it('commandResultPreview shows a header + bounded output (a marker when clipped, (no output) when empty)', () => {
    const short = commandResultPreview({ command: 'ls', args: [] }, 0, 'a\nb', '');
    expect(short).toBe('! ls (exit 0)\na\nb');
    expect(commandResultPreview({ command: 'true', args: [] }, 0, '', '')).toBe(
      '! true (exit 0)\n(no output)',
    );
    // stderr is appended under a `[stderr]` marker so a failing command's diagnostics are visible in the preview.
    expect(commandResultPreview({ command: 'npm', args: ['test'] }, 1, 'out', 'boom')).toBe(
      '! npm test (exit 1)\nout\n[stderr] boom',
    );
    // stderr-only (no stdout) still previews the diagnostics rather than "(no output)".
    expect(commandResultPreview({ command: 'git', args: [] }, 128, '', 'fatal')).toBe(
      '! git (exit 128)\n[stderr] fatal',
    );
    const long = commandResultPreview(
      { command: 'seq', args: ['100'] },
      0,
      Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n'),
      '',
      20,
    );
    expect(long.split('\n')).toHaveLength(22); // header + 20 lines + the "… more" marker
    expect(long).toContain('80 more lines');
  });

  it('commandResultPreview byte-bounds a single huge line (not just line count)', () => {
    // One giant line is under the 20-LINE cap but must still be byte-bounded (else ~1 MiB lands in the notice).
    const huge = 'x'.repeat(400 * 1024);
    const preview = commandResultPreview({ command: 'cat', args: ['blob'] }, 0, huge, '');
    expect(preview).toContain('[truncated'); // the byte cut fired
    expect(preview.length).toBeLessThan(huge.length); // materially smaller than the raw 400 KiB
  });

  it('appendAttachment dedups a FILE by path (a repeat @path is a no-op add)', () => {
    const first = appendAttachment([], file('src/a.ts', 'v1'));
    expect(first).toEqual({ list: [file('src/a.ts', 'v1')], dropped: 0 });
    // Re-adding the SAME path is a no-op — one chip per file (the original content is kept, not replaced).
    const again = appendAttachment(first.list, file('src/a.ts', 'v2'));
    expect(again.list).toBe(first.list); // unchanged reference
    expect(again.dropped).toBe(0);
    // A DIFFERENT path appends; a COMMAND never dedups (two identical commands are two chips).
    expect(appendAttachment(first.list, file('src/b.ts')).list).toHaveLength(2);
    const twoCmds = appendAttachment(appendAttachment([], cmd('ls')).list, cmd('ls'));
    expect(twoCmds.list).toHaveLength(2);
  });

  it('appendAttachment caps the list at MAX_PENDING_ATTACHMENTS, evicting the OLDEST + reporting the drop', () => {
    let list: readonly PendingAttachment[] = [];
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS; i += 1)
      list = appendAttachment(list, file(`f${i}.ts`)).list;
    expect(list).toHaveLength(MAX_PENDING_ATTACHMENTS);
    // The (MAX+1)th add evicts the oldest (f0) and reports dropped: 1 (so the caller can note it, not lose silently).
    const over = appendAttachment(list, file('newest.ts'));
    expect(over.list).toHaveLength(MAX_PENDING_ATTACHMENTS);
    expect(over.dropped).toBe(1);
    expect(over.list.some((a) => a.kind === 'file' && a.path === 'f0.ts')).toBe(false); // oldest gone
    expect(over.list.some((a) => a.kind === 'file' && a.path === 'newest.ts')).toBe(true); // newest kept
  });
});
