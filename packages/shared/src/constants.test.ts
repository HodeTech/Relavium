import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  MEDIA_SURFACES,
  RETRYABLE_ERROR_CODES,
  RUN_EVENT_TYPES,
} from './constants.js';

describe('error-code classification', () => {
  it('content_filter is a member of the closed ErrorCode union (1.AG/ADR-0045 §6)', () => {
    expect(ERROR_CODES).toContain('content_filter');
  });

  it('content_filter is FATAL — never in RETRYABLE_ERROR_CODES (a re-issue just re-blocks)', () => {
    // Pins the classification so a future edit cannot silently make a content-policy block retryable.
    expect(RETRYABLE_ERROR_CODES).not.toContain('content_filter');
  });

  it('every RETRYABLE code is a valid ErrorCode (the retryable set is a subset)', () => {
    for (const code of RETRYABLE_ERROR_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('tool_unavailable is a member of the closed ErrorCode union (EA1/ADR-0055)', () => {
    expect(ERROR_CODES).toContain('tool_unavailable');
  });

  it('tool_unavailable is FATAL — never in RETRYABLE_ERROR_CODES (re-issuing re-fails on the same host)', () => {
    // Pins the classification so a future edit cannot silently make a missing-capability gap retryable.
    expect(RETRYABLE_ERROR_CODES).not.toContain('tool_unavailable');
  });
});

describe('media constants', () => {
  it('media_job:submitted is a canonical run-event type (1.AG/ADR-0045 §2)', () => {
    expect(RUN_EVENT_TYPES).toContain('media_job:submitted');
  });

  it('MEDIA_SURFACES is the closed chat|generative routing set (1.AG/ADR-0045 §1)', () => {
    expect([...MEDIA_SURFACES]).toEqual(['chat', 'generative']);
  });
});
