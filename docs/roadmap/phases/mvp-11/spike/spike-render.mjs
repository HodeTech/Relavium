// MVP-11 Step 1 spike: an absolutely positioned popup over a full-screen Ink 7 body, mounted with the same
// options as the Home (alternateScreen: true, interactive, exitOnCtrlC false). No product code.
//   keys: o open · Esc/c close · s toggle a LATER SIBLING that covers popup rows · q quit
//   flags: --inline (popup in the normal flow, no alternate screen) · --tall (inline with a 5-line body)
import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { POPUP_W, POPUP_H, bodyLines, promptLine, popupLines, rect, OCCLUDER, occluderRect } from './model.mjs';

const h = React.createElement;
const inline = process.argv.includes('--inline');
const tall = process.argv.includes('--tall');
const noDim = process.argv.includes('--no-dim');
const leaky = process.argv.includes('--leaky'); // MUTANT: popup rows without their space padding and right border
const popupRows = () => (leaky ? popupLines().map((l) => l.replace(/ +│$/, '')) : popupLines());

function useSize() {
  const { stdout } = useStdout();
  const [s, set] = useState({ cols: stdout.columns, rows: stdout.rows });
  useEffect(() => {
    const f = () => set({ cols: stdout.columns, rows: stdout.rows });
    stdout.on('resize', f);
    return () => stdout.off('resize', f);
  }, [stdout]);
  return s;
}

function App() {
  const { exit } = useApp();
  const { cols, rows } = useSize();
  const [open, setOpen] = useState(process.argv.includes('--open'));
  const [occ, setOcc] = useState(false);
  useInput((input, key) => {
    if (input === 'q') exit();
    else if (input === 'o') setOpen(true);
    else if (key.escape || input === 'c') setOpen(false);
    else if (input === 's') setOcc((v) => !v);
  });

  const tooSmall = cols < 80 || rows < 24;
  const dim = open && !noDim;
  const body = bodyLines(cols, rows);

  if (inline) {
    // inline form: the popup is a framed block in the live region, in the flow, no absolute positioning
    const arg = process.argv.find((a) => a.startsWith('--body='));
    const lines = arg ? body.slice(0, Number(arg.slice(7))) : tall ? body.slice(0, 5) : [];
    return h(
      Box,
      { flexDirection: 'column' },
      ...lines.map((l, i) => h(Text, { key: `b${i}` }, l)),
      open ? h(Box, { flexDirection: 'column' }, ...popupLines().map((l, i) => h(Text, { key: `p${i}` }, l))) : null,
      h(Text, null, promptLine(cols)),
    );
  }

  const r = rect(cols, rows);
  const o = occluderRect(cols, rows);
  return h(
    Box,
    { width: cols, height: rows, flexDirection: 'column' },
    ...body.map((l, i) => h(Text, { key: `b${i}`, dimColor: dim }, l)),
    h(Text, { dimColor: dim }, promptLine(cols)),
    open && !tooSmall
      ? h(
          Box,
          { position: 'absolute', marginTop: r.top, marginLeft: r.left, width: POPUP_W, height: POPUP_H, flexDirection: 'column' },
          ...popupRows().map((l, i) => h(Text, { key: `p${i}` }, l)),
        )
      : null,
    open && tooSmall
      ? h(Box, { position: 'absolute', marginTop: 2, marginLeft: 2 }, h(Text, null, 'Too small for a popup. Esc closes it.'))
      : null,
    occ
      ? h(Box, { position: 'absolute', marginTop: o.top, marginLeft: o.left }, h(Text, { inverse: true }, OCCLUDER))
      : null,
  );
}

const app = render(h(App), {
  exitOnCtrlC: false,
  patchConsole: false,
  interactive: true,
  alternateScreen: !inline,
  maxFps: 20,
});
await app.waitUntilExit();
process.stdout.write('SPIKE-EXIT\n');
