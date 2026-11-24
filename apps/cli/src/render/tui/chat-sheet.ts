import type { BoundAgentView } from '../../chat/bound-agent-view.js';
import type { PermissionsSheetState } from './permissions-sheet.js';

/**
 * The docked sheet a chat has open, if any ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §1 and [ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1, §3): the
 * ONE slot of the chat's own overlays that is a sheet. A chat shows at most one at a time, because a sheet owns the keyboard while it is open
 * and the composer that would open a second one is not reachable, and the type says so: it is one value, not a pair of optionals. Each host
 * (the standalone chat and the in-Home chat) keeps exactly one such value, so a further docked sheet is a further kind here and a field
 * nowhere.
 *
 * - `permissions`: the commands remembered for this project and the ones approved for this session, and taking one back
 *   ({@link PermissionsSheetState}).
 * - `agent`: the agent this chat is bound to, read-only ({@link BoundAgentView}).
 *
 * The bare Home's `/permissions` is not this: it is the Permissions tab of the tab host, a kind of the Home's screen slot.
 */
export type ChatSheetState =
  | { readonly kind: 'permissions'; readonly sheet: PermissionsSheetState }
  | { readonly kind: 'agent'; readonly view: BoundAgentView };

/** The slot holding the permissions sheet `sheet`. */
export function permissionsChatSheet(sheet: PermissionsSheetState): ChatSheetState {
  return { kind: 'permissions', sheet };
}

/** The slot holding the sheet of the agent `view`. */
export function agentChatSheet(view: BoundAgentView): ChatSheetState {
  return { kind: 'agent', view };
}

/** The permissions sheet the slot holds, or `undefined` when it is empty or holds another kind. */
export function permissionsSheetOf(
  sheet: ChatSheetState | undefined,
): PermissionsSheetState | undefined {
  return sheet?.kind === 'permissions' ? sheet.sheet : undefined;
}
