import type { PermissionsSheetState } from './permissions-sheet.js';

/**
 * The docked sheet a chat has open, if any ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §1): the ONE slot of the chat's own overlays that is a sheet. A chat shows at most one at a time, because a sheet owns the keyboard while it
 * is open and the composer that would open a second one is not reachable, and the type says so: it is one value, not a pair of optionals. Each
 * host (the standalone chat and the in-Home chat) keeps exactly one such value.
 *
 * - `permissions`: the commands remembered for this project and the ones approved for this session, and taking one back
 *   ({@link PermissionsSheetState}).
 *
 * `/agent` was the second kind and is not a sheet any more: it is a report popup (MVP-11 step 4b, [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10), because what the person asked for is a report, not a question the system asks. The bare Home's `/permissions` is not this: it is the
 * Permissions tab of the tab host, a kind of the Home's screen slot.
 */
export type ChatSheetState = {
  readonly kind: 'permissions';
  readonly sheet: PermissionsSheetState;
};

/** The slot holding the permissions sheet `sheet`. */
export function permissionsChatSheet(sheet: PermissionsSheetState): ChatSheetState {
  return { kind: 'permissions', sheet };
}

/** The permissions sheet the slot holds, or `undefined` when it is empty. */
export function permissionsSheetOf(
  sheet: ChatSheetState | undefined,
): PermissionsSheetState | undefined {
  return sheet?.sheet;
}
