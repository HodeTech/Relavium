/**
 * SE7-8 (the scoped security sitting of unit 7): `directoryLabel` took any backslash in either path for a Windows path, so a POSIX directory whose
 * name holds one (`a\..\..\Library`, a legal name) was labelled `…/Library` and `x\y` under the home became `~/work/x/y`: a label that names
 * another place than the one the chat runs in. The platform now comes from the caller (`'win32'` or `'posix'`; the host's own when it says nothing),
 * and a backslash is a separator only on `'win32'`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { directoryLabelHere } from './display-roots.js';
import { directoryLabel } from './notation.js';

const HOME = '/Users/me';
const BACKSLASH = String.fromCharCode(0x5c);
/** Builds a path from its names with the backslash as the separator, so no escape is written in the source. */
const win = (...names: string[]): string => names.join(BACKSLASH);

describe('on a POSIX host a backslash is part of a name', () => {
  it('keeps a directory named with backslashes as the name it is, never as the places it spells', () => {
    const hostile = `/Users/me/${win('a', '..', '..', 'Library')}`;
    expect(directoryLabel(hostile, HOME, undefined, 'posix')).toBe(
      `~/${win('a', '..', '..', 'Library')}`,
    );
    expect(directoryLabel(hostile, HOME, undefined, 'posix')).not.toContain('~/Library');
  });

  it('keeps x\\y inside a directory as one name', () => {
    expect(directoryLabel(`/Users/me/work/${win('x', 'y')}`, HOME, undefined, 'posix')).toBe(
      `~/work/${win('x', 'y')}`,
    );
  });

  it('labels a relative directory with backslashes by its last SLASH-separated name', () => {
    expect(directoryLabel(win('a', '..', '..', 'Library'), HOME, undefined, 'posix')).toBe(
      `…/${win('a', '..', '..', 'Library')}`,
    );
    expect(directoryLabel(`work/${win('x', 'y')}`, HOME, undefined, 'posix')).toBe(
      `…/${win('x', 'y')}`,
    );
  });

  it('does not read a drive letter: `C:\\x` is a relative name on POSIX', () => {
    expect(
      directoryLabel(win('C:', 'Users', 'me'), win('C:', 'Users', 'me'), undefined, 'posix'),
    ).toBe(`…/${win('C:', 'Users', 'me')}`);
  });

  it('is unchanged for an ordinary POSIX path', () => {
    expect(directoryLabel('/Users/me/acme-web', HOME, undefined, 'posix')).toBe('~/acme-web');
    expect(directoryLabel('/srv/app', HOME, undefined, 'posix')).toBe('…/app');
  });
});

describe('on Windows the same inputs are read as Windows paths', () => {
  const home = win('C:', 'Users', 'me');

  it('reads a backslash as a separator, so the climb is seen and the label falls to the outside form', () => {
    expect(
      directoryLabel(
        win('C:', 'Users', 'me', 'a', '..', '..', 'Library'),
        home,
        undefined,
        'win32',
      ),
    ).toBe('…/Library');
  });

  it('writes x\\y under the home as two names with `/`', () => {
    expect(
      directoryLabel(win('C:', 'Users', 'me', 'work', 'x', 'y'), home, undefined, 'win32'),
    ).toBe('~/work/x/y');
  });

  it('labels a relative path with backslashes by its last name, never with a backslash', () => {
    const label = directoryLabel(win('a', '..', '..', 'Library'), home, undefined, 'win32');
    expect(label).toBe('…/Library');
    expect(label).not.toContain(BACKSLASH);
  });

  it('reads a path with forward slashes the same way', () => {
    expect(directoryLabel('c:/users/ME/acme', 'C:/Users/me', undefined, 'win32')).toBe('~/acme');
  });
});

describe('with no platform named a path is read by its shape, as before the platform was a parameter', () => {
  it('reads a drive letter or a backslash as a Windows path, and anything else as a POSIX one', () => {
    expect(directoryLabel(win('C:', 'Users', 'me', 'acme'), win('C:', 'Users', 'me'))).toBe(
      '~/acme',
    );
    expect(directoryLabel('/Users/me/acme', HOME)).toBe('~/acme');
    // the reading SE7-8 is about: a POSIX name with a backslash is read as a Windows path when nobody says otherwise
    expect(directoryLabel(`/Users/me/${win('x', 'y')}`, HOME)).toBe('~/x/y');
  });
});

describe('the host’s own platform is `directoryLabelHere`’s, where the process is read', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  const as = (platform: string): void => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  };
  afterEach(() => {
    if (real !== undefined) Object.defineProperty(process, 'platform', real);
  });

  it('reads a Windows path as one on a Windows host', () => {
    as('win32');
    expect(directoryLabelHere(win('C:', 'Users', 'me', 'acme'), win('C:', 'Users', 'me'))).toBe(
      '~/acme',
    );
  });

  it('reads a backslash as a name on every other host', () => {
    for (const platform of ['darwin', 'linux', 'freebsd']) {
      as(platform);
      expect(directoryLabelHere(`/Users/me/${win('x', 'y')}`, HOME), platform).toBe(
        `~/${win('x', 'y')}`,
      );
    }
  });

  it('is overridden by the platform the caller names, whatever the host is', () => {
    as('win32');
    expect(directoryLabelHere(`/Users/me/${win('x', 'y')}`, HOME, undefined, 'linux')).toBe(
      `~/${win('x', 'y')}`,
    );
    as('linux');
    expect(
      directoryLabelHere(
        win('C:', 'Users', 'me', 'acme'),
        win('C:', 'Users', 'me'),
        undefined,
        'win32',
      ),
    ).toBe('~/acme');
  });

  it('cuts to the bound after reading', () => {
    expect(directoryLabelHere('/Users/me/work/clients/acme', HOME, 12, 'linux')).toBe('…/acme');
  });
});

describe('the bound still applies after the label is read', () => {
  it('cuts from the lead on either platform', () => {
    expect(directoryLabel('/Users/me/work/clients/acme', HOME, 12, 'posix')).toBe('…/acme');
    expect(
      directoryLabel(
        win('C:', 'Users', 'me', 'work', 'clients', 'acme'),
        win('C:', 'Users', 'me'),
        12,
        'win32',
      ),
    ).toBe('…/acme');
  });
});
