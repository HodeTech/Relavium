/**
 * The palette's own legend row, as the palette draws it ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §3): written out here, not built by the legend builder, because the builder is part of what the matrix checks. The Home's palette and both
 * chats' palette draw this one row, whole, on one row of the frame in every cell (`legend-row`, `properties.ts`).
 */
export const PALETTE_LEGEND_ROW = '↑/↓ select · Enter run · Esc close';
