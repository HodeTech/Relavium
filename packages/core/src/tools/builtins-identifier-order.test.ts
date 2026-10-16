import { describe, expect, it, vi } from 'vitest';

const expectedBuiltinIds = [
  'git_commit',
  'git_status',
  'http_request',
  'invoke_agent',
  'list_directory',
  'mcp_call',
  'notify',
  'read_clipboard',
  'read_file',
  'read_media',
  'run_command',
  'web_search',
  'write_file',
];

describe('built-in catalog identifier ordering (#259)', () => {
  it('preserves the fixed thirteen-ID catalog through actual module evaluation', async () => {
    const catalog = await import('./builtins.js');
    expect(catalog.BUILTIN_TOOL_IDS, 'fixed built-in catalog preservation').toEqual(
      expectedBuiltinIds,
    );
    expect(catalog.BUILTIN_TOOLS).toHaveLength(13);
    expect(catalog.BUILTIN_TOOLS.every((tool) => tool.source === 'builtin')).toBe(true);
    expect(new Set(catalog.BUILTIN_TOOLS.map((tool) => tool.id))).toEqual(
      new Set(expectedBuiltinIds),
    );
  });

  it('fresh catalog import never calls ambient locale collation', async () => {
    vi.resetModules();
    const ambient = vi.spyOn(String.prototype, 'localeCompare');
    try {
      const catalog = await import('./builtins.js');
      expect(
        catalog.BUILTIN_TOOL_IDS,
        'import-time builtin sort is independent of ambient collation',
      ).toEqual(expectedBuiltinIds);
      expect(ambient).not.toHaveBeenCalled();
    } finally {
      ambient.mockRestore();
      vi.resetModules();
    }
  });
});
