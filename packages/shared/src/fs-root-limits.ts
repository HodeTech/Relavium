/** Shared admission/selector bounds (ADR-0105). Syntax limits never grant a path. */
export const FS_ROOT_LIMITS = Object.freeze({ count: 16, characters: 4096 });
