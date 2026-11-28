import type { FsScopeTier } from '@relavium/core';

import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import type { FsPathPolicy } from '../engine/tool-host/fs-policy.js';
import { createMentionReader, type MentionReader } from '../render/tui/mention.js';

/**
 * The ONE factory of the Home's `@`-mention readers (2.5.D, [ADR-0061](../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)):
 * a chat the Home hosts gets one at its session's tier and working directory, and the Home's own two prompts (the landing and the work
 * page's docked prompt, which have no session) get one at the tier and the directory the next chat runs at. Both are the READ-ONLY filesystem
 * capability (`chat-read-only`) over the same invocation policy, so `@` on the Home browses and reads through the identical jail, the
 * confidentiality floor (`.ssh`, `.aws`, `.env`-class paths are never listed and never read), the symbolic-link containment and the binary
 * and size guards as a chat's tools: nothing here is a guard of its own, and none is weakened. It never writes.
 */
export interface MentionReaderScope {
  readonly operatorHomeDir: string;
  /** The effective tier (`clampChatTier`): `full` is never read from a chat surface. */
  readonly fsScopeTier: FsScopeTier;
  /** The working directory the jail is anchored at (absolute). */
  readonly workspaceDir: string;
  /** The invocation's host-owned policy (its admitted extra roots and pinned identities). */
  readonly fsPolicy?: FsPathPolicy | undefined;
}

/** A reader over `scope`, or `undefined` when the filesystem arm is not available. */
export function scopedMentionReader(scope: MentionReaderScope): MentionReader | undefined {
  const fs = assembleToolEnv({
    profile: 'chat-read-only',
    operatorHomeDir: scope.operatorHomeDir,
    fsScopeTier: scope.fsScopeTier,
    workspaceDir: scope.workspaceDir,
    ...(scope.fsPolicy === undefined ? {} : { fsPolicy: scope.fsPolicy }),
  }).host.fs;
  return fs === undefined ? undefined : createMentionReader(fs);
}

/**
 * A reader built when it is first used (the Home's own: a Home whose person never types `@` builds no filesystem capability), then kept for the
 * Home's life. A build that fails, or a Home with no filesystem arm, rejects the listing or the read that asked for it (the picker then shows
 * nothing and the read says it could not read the file), and the next use tries again.
 */
export function lazyMentionReader(build: () => MentionReader | undefined): MentionReader {
  let built: MentionReader | undefined;
  const reader = (): MentionReader => {
    built ??= build();
    if (built === undefined) throw new Error('The @ file picker is unavailable here.');
    return built;
  };
  return {
    list: (dir) => Promise.resolve().then(() => reader().list(dir)),
    read: (path) => Promise.resolve().then(() => reader().read(path)),
  };
}
