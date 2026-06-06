import { describe, expect, it } from 'vitest';

import { ContentPartSchema } from './content.js';
import type { AbortSignalLike, ContentPart } from './content.js';

describe('ContentPartSchema', () => {
  it('accepts each of the three content-part variants', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
      { type: 'tool_result', toolCallId: 'c1', result: { ok: true }, isError: false },
    ];
    for (const part of parts) {
      expect(ContentPartSchema.safeParse(part).success).toBe(true);
    }
  });

  it('accepts a tool_result without the optional isError', () => {
    expect(
      ContentPartSchema.safeParse({ type: 'tool_result', toolCallId: 'c1', result: 'done' })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown content-part type', () => {
    expect(ContentPartSchema.safeParse({ type: 'image', url: 'x' }).success).toBe(false);
  });

  it('rejects a tool_call with an empty id or name', () => {
    expect(
      ContentPartSchema.safeParse({ type: 'tool_call', id: '', name: 'f', args: {} }).success,
    ).toBe(false);
    expect(
      ContentPartSchema.safeParse({ type: 'tool_call', id: 'c1', name: '', args: {} }).success,
    ).toBe(false);
  });

  it('rejects a tool_call missing its name (a required field)', () => {
    expect(ContentPartSchema.safeParse({ type: 'tool_call', id: 'c1', args: {} }).success).toBe(
      false,
    );
  });
});

describe('AbortSignalLike', () => {
  it('is a usable minimal cancellation handle', () => {
    // Constructed structurally — a real `AbortSignal` (typed only in surface code, which carries
    // the DOM/node lib) satisfies this same shape, which is the point: the platform-free packages
    // thread cancellation through it without pulling in `AbortSignal`'s lib here.
    let fired = false;
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener: (_type, listener) => listener(),
      removeEventListener: () => undefined,
    };
    signal.addEventListener('abort', () => {
      fired = true;
    });
    expect(signal.aborted).toBe(false);
    expect(fired).toBe(true);
  });
});
