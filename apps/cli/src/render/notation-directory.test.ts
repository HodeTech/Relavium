/**
 * `directoryLabel`, `cutPathNames` and `cutPathLead` of `notation.ts`: the working directory as the ONE label the status line draws
 * ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §2). The label is
 * from `~` or from the end of the path behind `…/`, never absolute, with `/` for a separator on every platform, and it is computed from the
 * strings it is given: nothing here reads the filesystem or the process.
 */
import { describe, expect, it } from 'vitest';

import { cutPathLead, cutPathNames, directoryLabel, PATH_ELLIPSIS } from './notation.js';
import { displayWidth } from './tui/viewport.js';

const HOME = '/Users/me';

describe('a directory inside the operator home', () => {
  it('is written from ~ with the names after it', () => {
    expect(directoryLabel('/Users/me/acme-web', HOME)).toBe('~/acme-web');
    expect(directoryLabel('/Users/me/work/clients/acme', HOME)).toBe('~/work/clients/acme');
  });

  it('is ~ alone for the home itself', () => {
    expect(directoryLabel('/Users/me', HOME)).toBe('~');
  });

  it('does not count a trailing separator or a doubled one', () => {
    expect(directoryLabel('/Users/me/acme-web/', HOME)).toBe('~/acme-web');
    expect(directoryLabel('/Users/me/', HOME)).toBe('~');
    expect(directoryLabel('/Users//me//acme-web', HOME)).toBe('~/acme-web');
    expect(directoryLabel('/Users/me/acme-web', '/Users/me/')).toBe('~/acme-web');
  });

  it('does not take a sibling whose name only STARTS like the home for a folder of it', () => {
    expect(directoryLabel('/Users/mellon/app', HOME)).toBe('…/app');
    expect(directoryLabel('/Users/me2', HOME)).toBe('…/me2');
  });

  it('is case-sensitive on a path that is not a Windows path', () => {
    expect(directoryLabel('/users/ME/app', HOME)).toBe('…/app');
  });
});

describe('a directory outside the operator home', () => {
  it('is its LAST name behind …/, never an absolute path and never the middle of one', () => {
    expect(directoryLabel('/srv/app', HOME)).toBe('…/app');
    expect(directoryLabel('/opt/builds/2026/relavium', HOME)).toBe('…/relavium');
  });

  it('is …/<name> for a top-level folder too, not the bare absolute path', () => {
    expect(directoryLabel('/app', HOME)).toBe('…/app');
  });

  it('is …/<last name> when no home is known', () => {
    expect(directoryLabel('/Users/me/acme-web', undefined)).toBe('…/acme-web');
    expect(directoryLabel('/Users/me/acme-web', '')).toBe('…/acme-web');
  });

  it('is / for a path with no name (the filesystem root), and the root home shortens nothing', () => {
    expect(directoryLabel('/', HOME)).toBe('/');
    expect(directoryLabel('/srv/app', '/')).toBe('…/app');
  });

  it('is the empty string for an empty directory', () => {
    expect(directoryLabel('', HOME)).toBe('');
  });

  it('never shows a path that climbs out of the home as if it stayed in', () => {
    expect(directoryLabel('/Users/me/../other', HOME)).toBe('…/other');
    expect(directoryLabel('/Users/me/./acme', HOME)).toBe('…/acme');
  });

  it('writes a relative path it is wrongly given from its end too, and still never with a backslash', () => {
    expect(directoryLabel('work/acme', HOME)).toBe('…/acme');
    expect(directoryLabel('work\\acme', HOME)).toBe('…/acme');
  });
});

describe('a Windows path', () => {
  const winHome = 'C:\\Users\\me';

  it('folds its backslashes to / and keeps ~ for the home', () => {
    expect(directoryLabel('C:\\Users\\me\\acme-web', winHome)).toBe('~/acme-web');
    expect(directoryLabel('C:\\Users\\me\\work\\acme', winHome)).toBe('~/work/acme');
    expect(directoryLabel('C:\\Users\\me', winHome)).toBe('~');
  });

  it('compares the case of ASCII letters only, so a drive and a folder written in another case are the same place', () => {
    expect(directoryLabel('c:\\users\\ME\\acme', winHome)).toBe('~/acme');
    expect(directoryLabel('c:/users/me/acme', winHome)).toBe('~/acme');
  });

  it('does not fold the Kelvin sign into a k: a name that only looks like the home is outside it', () => {
    expect(directoryLabel('C:\\Users\\\u212Aelvin\\x', 'C:\\Users\\kelvin')).toBe('…/x');
  });

  it('drops the drive letter and shows an outside path from its end', () => {
    expect(directoryLabel('D:\\work\\acme', winHome)).toBe('…/acme');
    expect(directoryLabel('C:\\Windows\\System32', winHome)).toBe('…/System32');
  });

  it('reads a drive-letter path written with forward slashes only as a Windows path (its case-insensitive names)', () => {
    expect(directoryLabel('c:/users/ME/acme', 'C:/Users/me')).toBe('~/acme');
    expect(directoryLabel('d:/users/me/acme', 'C:/Users/me')).toBe('…/acme');
  });

  it('reads a rooted path written with backslashes and no drive letter as a Windows path', () => {
    expect(directoryLabel('\\Users\\me\\acme', '\\Users\\me')).toBe('~/acme');
    expect(directoryLabel('\\Users\\ME\\acme', '\\Users\\me')).toBe('~/acme');
  });

  it('does not count a trailing backslash', () => {
    expect(directoryLabel('C:\\Users\\me\\acme\\', winHome)).toBe('~/acme');
  });

  it('is / for a drive root and …/<name> for a UNC share', () => {
    expect(directoryLabel('C:\\', winHome)).toBe('/');
    expect(directoryLabel('\\\\server\\share\\proj', winHome)).toBe('…/proj');
  });

  it('reads a POSIX path against a Windows home as outside it', () => {
    expect(directoryLabel('/Users/me/acme', winHome)).toBe('…/acme');
  });

  it('never writes a backslash or a drive letter', () => {
    const labels = [
      directoryLabel('C:\\Users\\me\\a\\b', winHome),
      directoryLabel('D:\\x\\y', winHome),
      directoryLabel('C:\\', winHome),
      directoryLabel('\\\\h\\s\\p', winHome),
    ];
    for (const label of labels) {
      expect(label).not.toContain('\\');
      expect(label).not.toMatch(/^[A-Za-z]:/u);
    }
  });
});

describe('a very long directory', () => {
  const long = 'x'.repeat(300);

  it('is written whole when no bound is given: cutting is the caller’s', () => {
    expect(directoryLabel(`/Users/me/${long}`, HOME)).toBe(`~/${long}`);
    expect(directoryLabel(`/srv/${long}`, HOME)).toBe(`…/${long}`);
  });

  it('is cut at its lead to the bound, keeping the end', () => {
    const label = directoryLabel(`/Users/me/${long}`, HOME, 20);
    expect(label).toBe(`…${'x'.repeat(19)}`);
    expect(displayWidth(label)).toBe(20);
  });

  it('keeps the trailing names that fit when the bound is given', () => {
    expect(directoryLabel('/Users/me/work/clients/acme/web', HOME, 18)).toBe('…/clients/acme/web');
    expect(directoryLabel('/Users/me/work/clients/acme/web', HOME, 17)).toBe('…/acme/web');
    expect(directoryLabel('/Users/me/work/clients/acme/web', HOME, 10)).toBe('…/acme/web');
    expect(directoryLabel('/Users/me/work/clients/acme/web', HOME, 9)).toBe('…/web');
  });

  it('returns the label as it is when it fits the bound', () => {
    expect(directoryLabel('/Users/me/acme-web', HOME, 10)).toBe('~/acme-web');
    expect(directoryLabel('/Users/me/acme-web', HOME, 80)).toBe('~/acme-web');
  });
});

describe('cutPathNames', () => {
  it('replaces the leading names by …, keeping the longest run of trailing names that fits', () => {
    const label = '~/work/clients/acme/web';
    expect(cutPathNames(label, 23)).toBe(label);
    expect(cutPathNames(label, 22)).toBe('…/clients/acme/web');
    expect(cutPathNames(label, 18)).toBe('…/clients/acme/web');
    expect(cutPathNames(label, 17)).toBe('…/acme/web');
    expect(cutPathNames(label, 9)).toBe('…/web');
  });

  it('never cuts the last name: it returns …/<last> wider than the room rather than half a name', () => {
    expect(cutPathNames('~/work/web-frontend', 4)).toBe('…/web-frontend');
    expect(cutPathNames('…/web-frontend', 4)).toBe('…/web-frontend');
  });

  it('returns a single name as it is, whatever the room', () => {
    expect(cutPathNames('~', 0)).toBe('~');
    expect(cutPathNames('app', 1)).toBe('app');
  });

  it('measures display columns, not characters: a CJK name is two columns a character', () => {
    expect(cutPathNames('~/项目/客户端', 10)).toBe('…/客户端');
    expect(displayWidth(cutPathNames('~/项目/客户端', 10))).toBe(8);
    expect(cutPathNames('~/项目/客户端', 9)).toBe('…/客户端');
  });
});

describe('cutPathLead', () => {
  it('is cutPathNames when the last name fits behind …/', () => {
    expect(cutPathLead('~/work/clients/acme/web', 18)).toBe('…/clients/acme/web');
    expect(cutPathLead('~/work/web-frontend', 14)).toBe('…/web-frontend');
  });

  it('cuts the last name by characters, from its front, when even …/<last> does not fit', () => {
    expect(cutPathLead('~/work/web-frontend', 13)).toBe('…web-frontend');
    expect(cutPathLead('~/work/web-frontend', 8)).toBe('…rontend');
    expect(cutPathLead('…/web-frontend', 5)).toBe('…tend');
  });

  it('never exceeds the room, for every room from 0 to 40 and for wide characters', () => {
    const labels = [
      '~/work/clients/acme/web-frontend',
      '…/项目客户端应用',
      `~/${'漢'.repeat(30)}`,
      `…/${'x'.repeat(100)}`,
    ];
    for (const label of labels) {
      for (let room = 0; room <= 40; room += 1) {
        expect(
          displayWidth(cutPathLead(label, room)),
          `${label} in ${String(room)}`,
        ).toBeLessThanOrEqual(room);
      }
    }
  });

  it('is a lone … for a room of one and empty for a room of zero or less', () => {
    expect(cutPathLead('~/work/acme', 1)).toBe(PATH_ELLIPSIS);
    expect(cutPathLead('~/work/acme', 0)).toBe('');
    expect(cutPathLead('~/work/acme', -3)).toBe('');
  });

  it('leaves out a wide character that would straddle the cut instead of splitting it', () => {
    expect(cutPathLead(`~/${'漢'.repeat(10)}`, 6)).toBe('…漢漢');
    expect(displayWidth(cutPathLead(`~/${'漢'.repeat(10)}`, 6))).toBe(5);
  });

  it('returns a label that fits as it is', () => {
    expect(cutPathLead('~/acme-web', 10)).toBe('~/acme-web');
  });
});
