import type { EditorState } from './chat-input.js';
import { shouldShowBanner } from './banner.js';
import { sanitizeInline } from './chat-projection.js';
import { displayWidth, wrapText } from './viewport.js';

export function homePromptRows(editor: EditorState, columns: number): number {
  return editor.text
    .split('\n')
    .reduce(
      (sum, line) =>
        sum + Math.max(1, Math.ceil((displayWidth(sanitizeInline(line)) + 3) / columns)),
      0,
    );
}

export interface HomeNoticeOptions {
  readonly notice: string | undefined;
  readonly editor: EditorState;
  readonly cols: number;
  readonly rows: number;
  readonly keyless: boolean;
  readonly errorText: string | undefined;
  readonly showBanner: boolean | undefined;
  readonly isEmpty: boolean;
  readonly hasSessions: boolean;
  readonly page?: number;
}
export interface HomeNoticeLayout {
  readonly lines: readonly string[];
  readonly footer: string | undefined;
  readonly page: number;
  readonly maxPage: number;
  readonly rowCount: number;
}

/** Keep the full source; page only its wrapped presentation after reserving Home's actionable chrome. */
export function layoutHomeNotice(options: HomeNoticeOptions): HomeNoticeLayout | undefined {
  if (options.notice === undefined) return undefined;
  const heading = shouldShowBanner({
    configShowBanner: options.showBanner,
    isEmpty: options.isEmpty,
    rows: options.rows,
  })
    ? 4
    : 1;
  // One Continue row needs body margin + two headings + its title/directory lines.
  const management = options.hasSessions ? 5 : options.isEmpty ? 0 : 1;
  const available = Math.max(
    2,
    options.rows -
      heading -
      homePromptRows(options.editor, options.cols) -
      3 -
      (options.keyless ? 1 : 0) -
      (options.errorText === undefined ? 0 : 2) -
      management,
  );
  const all = wrapText(options.notice.split('\n').map(sanitizeInline).join('\n'), options.cols);
  const overflow = all.length > available;
  const pageSize = overflow ? available - 1 : available;
  const maxPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const requested = options.page ?? 0;
  const page = Number.isSafeInteger(requested) ? Math.min(maxPage, Math.max(0, requested)) : 0;
  const start = page * pageSize;
  const lines = all.slice(start, start + pageSize);
  const footer = overflow
    ? `Notice ${start + 1}–${start + lines.length} of ${all.length} · PgUp/PgDn to read`
    : undefined;
  return { lines, footer, page, maxPage, rowCount: lines.length + (footer === undefined ? 0 : 1) };
}
