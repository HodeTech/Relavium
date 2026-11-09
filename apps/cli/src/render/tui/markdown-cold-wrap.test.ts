import { describe, expect, it } from 'vitest';

import { wrapTranscript } from './chat-projection.js';
import type { TranscriptEntry } from './session-view-model.js';
import { displayWidth } from './viewport.js';

function conversation(): TranscriptEntry[] {
  return Array.from({ length: 250 }, (_, index) => [
    { role: 'user' as const, text: `Question ${index}: 中 é 👩‍💻\twords` },
    {
      role: 'assistant' as const,
      text: `# Answer ${index}\n\nA **readable** answer with 中 é 👩‍💻 and [source](https://example.test/a).\n\n| Item | Value |\n| --- | ---: |\n| 中 | é |\n\n\x60\x60\x60ts\n\tconst token = '${'x'.repeat(256)}';\n\x60\x60\x60`,
      summary: { stopReason: 'stop' as const, tokensUsed: { input: 20, output: 40 } },
    },
  ]).flat();
}

describe('a 500-entry restore with actual rich assistant entries', () => {
  it('lays out cold entries, reuses parsing on resize and caches repeated rows', () => {
    const entries = conversation();
    expect(entries).toHaveLength(500);
    const rows = wrapTranscript(entries, 80, true);
    expect(rows.some((row) => row.text.startsWith('┌'))).toBe(true);
    expect(rows.every((row) => displayWidth(row.text) <= 80)).toBe(true);
    const cached = wrapTranscript(entries, 80, true);
    expect(cached).toEqual(rows);
    expect(cached.every((row, index) => row === rows[index])).toBe(true);
    const resized = wrapTranscript(entries, 40, true);
    expect(resized.every((row) => displayWidth(row.text) <= 40)).toBe(true);
    const plain = wrapTranscript(entries, 80, false);
    expect(plain.some((row) => row.text.includes('**readable**'))).toBe(true);
    expect(plain.some((row) => row.text.startsWith('┌'))).toBe(false);
  });
});
