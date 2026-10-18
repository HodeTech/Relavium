import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { buildChatSession } from './session-host.js';
import { SessionHostOwner } from './session-host-owner.js';
import { scriptedResolver } from './test-support.js';

function gate() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function fixture(refuseCore = false) {
  const control = invocationFixture();
  const owner = new SessionHostOwner(control.invocation, 'chat');
  const core = gate();
  const native = gate();
  const close = vi.fn(() => native.promise);
  const built = await owner.build(async (workOwner) => {
    const actual = await buildChatSession({
      workOwner,
      chat: resolveConfig({}).chat,
      agentRef: undefined,
      cwd: '/tmp',
      projectConfigDir: undefined,
      now: Date.now,
      uuid: () => 'mcp-close-order',
      providers: scriptedResolver([]),
    });
    return {
      ...actual,
      whenHostSafeToClose: async () => {
        await core.promise;
        if (refuseCore) throw new Error('synthetic core accounting refusal');
        await actual.whenHostSafeToClose();
      },
      closeMcp: close,
    };
  });
  // Unit representation of the actual SDK's transferred nativeClosed lifetime.
  // The separate child-process suite verifies the real native transport/OS signal boundaries.
  const receipt = owner.work.work.retainWork(() => native.promise);
  return { control, owner, core, native, close, built, receipt };
}

describe('MCP close initiation precedes transferred native receipt join', () => {
  it('joins entered roots and actual core work before closing once, then joins every transferred tail', async () => {
    const f = await fixture();
    const root = gate();
    const tail = gate();
    const entered = f.owner.work.enter(() => root.promise);
    const transferred = f.owner.work.work.retainWork(() => tail.promise);
    let settled = false;
    const closing = f.owner.work.close().then(() => {
      settled = true;
    });
    await reactions();
    expect(f.close, 'ENTERED_ROOT_PRECEDES_MCP_CLOSE').not.toHaveBeenCalled();
    root.release();
    await entered;
    await reactions();
    expect(f.close, 'ACTUAL_CORE_BARRIER_PRECEDES_MCP_CLOSE').not.toHaveBeenCalled();
    f.core.release();
    await reactions();
    expect(f.close, 'MCP_CLOSE_REQUEST_PRECEDES_NATIVE_ACK_JOIN').toHaveBeenCalledOnce();
    expect(f.close.mock.contexts[0], 'MCP_CLOSE_PRESERVES_BUILT_HOST_RECEIVER').toMatchObject({
      session: f.built.session,
      closeMcp: f.close,
    });
    expect(settled, 'CLOSE_REQUEST_IS_NOT_ACK').toBe(false);
    expect(f.control.registry.activeOwners).toBe(1);
    f.owner.cancel();
    expect(f.owner.work.close()).toBe(f.owner.work.close());
    f.native.release();
    await f.receipt;
    await reactions();
    expect(settled, 'FINAL_CLEANUP_STILL_OWES_OTHER_TRANSFERRED_TAILS').toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    tail.release();
    await transferred;
    await closing;
    expect(f.control.registry.activeOwners).toBe(0);
  });

  it('does not enter MCP close after the original finite budget expires while core work joins', async () => {
    const f = await fixture();
    let settled = false;
    void f.owner.work.close().then(() => {
      settled = true;
    });
    f.control.invocation.finiteExit.signal(15);
    f.control.advance(3000);
    await reactions();
    f.core.release();
    await reactions();
    expect(f.close, 'EXHAUSTED_BUDGET_REFUSES_NEW_MCP_CLOSE').not.toHaveBeenCalled();
    expect(f.control.registry.budget.deadline()).toBe(3000);
    expect(f.control.exit).toHaveBeenCalledExactlyOnceWith(143);
    expect(settled).toBe(false);
    expect(f.control.registry.activeOwners).toBe(1);
    // Administrative unit fixture disposal does not grant product native closure or retirement.
    f.native.release();
    await f.receipt;
  });
  it('attempts sibling MCP cleanup after a quiescent core refusal without granting retirement', async () => {
    const f = await fixture(true);
    let settled = false;
    void f.owner.work.close().then(() => {
      settled = true;
    });
    f.core.release();
    await reactions();
    expect(f.close, 'QUIESCENT_CORE_FAILURE_STILL_ATTEMPTS_MCP_CLOSE').toHaveBeenCalledOnce();
    f.native.release();
    await f.receipt;
    await reactions();
    expect(f.control.registry.observations.exitCode()).toBe(9);
    expect(f.control.registry.activeOwners).toBe(1);
    expect(settled, 'CORE_FAILURE_NEVER_FABRICATES_CLEANUP_ACK').toBe(false);
  });
});
