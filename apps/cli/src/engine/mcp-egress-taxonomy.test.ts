import { SAFE_EGRESS_ERROR_CODES } from '@relavium/db';
import { McpConnectError } from '@relavium/mcp';
import { describe, expect, it } from 'vitest';

/**
 * Every `SafeEgressErrorCode` classifies to a reason a user can act on
 * ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §9).
 *
 * **It lives in `apps/cli` because this is the only layer that sees both packages.** `@relavium/mcp` maps the
 * codes without depending on `@relavium/db` — a type import is not worth a new package edge — so the mapping
 * is a record keyed by string, and nothing in `@relavium/mcp` can tell whether it covers the union. That gap
 * is exactly how four of the six codes came to report "the endpoint redirected", including `too_large`, which
 * is the transport byte bound firing.
 *
 * The list is now a VALUE (`SAFE_EGRESS_ERROR_CODES`) rather than a bare union precisely so this can iterate
 * it: a code added in `@relavium/db` reddens here until someone classifies it.
 */
describe('the MCP connect taxonomy covers every egress code', () => {
  const reasonFor = (code: string): string =>
    new McpConnectError('s', {
      cause: Object.assign(new Error('x'), { name: 'SafeEgressError', code }),
    }).reason;

  it.each(SAFE_EGRESS_ERROR_CODES)('classifies %s to something other than `unknown`', (code) => {
    expect(reasonFor(code)).not.toBe('unknown');
  });

  it('an UNRECOGNISED code still falls back to `unknown` rather than a wrong reason', () => {
    // Fail-open on the LABEL, never on the classification: inventing a reason for a code we do not know is
    // how the previous version told users to look for a redirect that had not happened.
    expect(reasonFor('not_a_real_code')).toBe('unknown');
  });
});
