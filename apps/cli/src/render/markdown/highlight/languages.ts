import { scanCss } from './css.js';
import { scanDiff } from './diff.js';
import { genericScanner } from './generic.js';
import { scanMarkup } from './markup.js';
import {
  C,
  CPP,
  CSHARP,
  DOCKERFILE,
  GO,
  JAVA,
  JAVASCRIPT,
  JSON_PROFILE,
  PYTHON,
  RUST,
  SQL,
  TYPESCRIPT,
} from './profiles.js';
import type { Scanner } from './segments.js';
import { scanShell } from './shell.js';
import { scanIni, scanToml } from './toml.js';
import { scanYaml } from './yaml.js';

/** One language family the highlighter reads, with the info strings that name it. */
export interface HighlightLanguage {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly scan: Scanner;
}

/** Every language the highlighter supports. The reference's table is checked against this list by a test. */
export const HIGHLIGHT_LANGUAGES: readonly HighlightLanguage[] = [
  {
    id: 'typescript',
    aliases: ['typescript', 'ts', 'tsx', 'mts', 'cts'],
    scan: genericScanner(TYPESCRIPT),
  },
  {
    id: 'javascript',
    aliases: ['javascript', 'js', 'jsx', 'mjs', 'cjs', 'node', 'nodejs'],
    scan: genericScanner(JAVASCRIPT),
  },
  { id: 'json', aliases: ['json', 'jsonc', 'json5', 'jsonl'], scan: genericScanner(JSON_PROFILE) },
  { id: 'python', aliases: ['python', 'py', 'python3', 'py3'], scan: genericScanner(PYTHON) },
  { id: 'shell', aliases: ['bash', 'sh', 'shell', 'zsh', 'ksh', 'dash'], scan: scanShell },
  { id: 'yaml', aliases: ['yaml', 'yml'], scan: scanYaml },
  { id: 'toml', aliases: ['toml'], scan: scanToml },
  { id: 'ini', aliases: ['ini', 'cfg', 'properties', 'env', 'dotenv'], scan: scanIni },
  { id: 'diff', aliases: ['diff', 'patch', 'udiff'], scan: scanDiff },
  {
    id: 'sql',
    aliases: [
      'sql',
      'psql',
      'mysql',
      'postgres',
      'postgresql',
      'sqlite',
      'pgsql',
      'plpgsql',
      'tsql',
    ],
    scan: genericScanner(SQL),
  },
  { id: 'go', aliases: ['go', 'golang'], scan: genericScanner(GO) },
  { id: 'rust', aliases: ['rust', 'rs'], scan: genericScanner(RUST) },
  { id: 'java', aliases: ['java'], scan: genericScanner(JAVA) },
  { id: 'c', aliases: ['c', 'h'], scan: genericScanner(C) },
  {
    id: 'cpp',
    aliases: ['cpp', 'c++', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'cplusplus'],
    scan: genericScanner(CPP),
  },
  { id: 'csharp', aliases: ['csharp', 'cs', 'c#'], scan: genericScanner(CSHARP) },
  {
    id: 'markup',
    aliases: ['html', 'htm', 'xml', 'svg', 'xhtml', 'plist', 'xsd', 'rss'],
    scan: scanMarkup,
  },
  { id: 'css', aliases: ['css'], scan: scanCss },
  {
    id: 'dockerfile',
    aliases: ['dockerfile', 'docker', 'containerfile'],
    scan: genericScanner(DOCKERFILE),
  },
];

const BY_ALIAS: ReadonlyMap<string, HighlightLanguage> = new Map(
  HIGHLIGHT_LANGUAGES.flatMap((language) =>
    language.aliases.map((alias) => [alias, language] as const),
  ),
);

function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 43 ||
    code === 35 ||
    code === 45
  );
}

/**
 * The language an info string names, or undefined. Only its first word counts: `ts title="a.ts"`, `{.ts}`,
 * `typescript{1,3}` and `language-ts` all name TypeScript, and `ts:src/a.ts` does too. No content sniffing: a block with
 * no info string, or one the highlighter does not know, is not highlighted.
 */
export function languageOf(info: string | undefined): HighlightLanguage | undefined {
  if (info === undefined) return undefined;
  let at = 0;
  while (
    at < info.length &&
    (info[at] === '{' || info[at] === '.' || info[at] === ' ' || info[at] === '\t')
  )
    at += 1;
  let end = at;
  while (end < info.length && isNameChar(info.charCodeAt(end))) end += 1;
  const name = info.slice(at, end).toLowerCase();
  return BY_ALIAS.get(name.startsWith('language-') ? name.slice('language-'.length) : name);
}
