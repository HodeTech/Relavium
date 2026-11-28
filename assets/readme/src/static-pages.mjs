// The README's three still images, as HTML pages painted in the pastel theme (rendered at 2x by the browser).
// The chat card of the hero is a frame of the application's own chat view; the other cards use the product's real formats.
import { readFileSync } from 'node:fs';
import { parseAnsi } from './ansi.mjs';
import { rowHtml, THEME } from './frame-html.mjs';

const SANS = `-apple-system, "SF Pro Display", "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif`;
const MONO = `Menlo, "SF Mono", ui-monospace, Consolas, "DejaVu Sans Mono", monospace`;

const P = {
  base: '#F8F6FD',
  ink: '#34315A',
  soft: '#6B6890',
  faint: '#A19EBE',
  lav: '#E4DBFB',
  lavDeep: '#7A6BD8',
  lavText: '#6E62C9',
  mint: '#D8F0E5',
  mintDeep: '#3F9A78',
  peach: '#FCE4D6',
  peachDeep: '#BF7440',
  sky: '#DCE8FB',
  skyDeep: '#4F78CC',
  rose: '#F9DCE6',
  roseDeep: '#BC557F',
  butter: '#FBF0CF',
  butterDeep: '#A98A2E',
  card: '#FFFFFF',
  line: '#E7E2F6',
  shadow: '0 18px 40px rgba(110,98,201,.10), 0 2px 6px rgba(110,98,201,.06)',
};

const baseCss = (w, h) => `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{width:${w}px;height:${h}px;position:relative;overflow:hidden;background:${P.base};font-family:${SANS};color:${P.ink}}
  .blob{position:absolute;border-radius:50%;filter:blur(64px)}
  .card{position:absolute;background:${P.card};border:1px solid ${P.line};border-radius:14px;box-shadow:${P.shadow};overflow:hidden}
  .bar{height:30px;background:#F4F1FB;border-bottom:1px solid ${P.line};position:relative;font:600 11.5px/30px ${SANS};color:${P.faint};text-align:left;padding-left:66px;letter-spacing:.03em}
  .bar i{position:absolute;top:10px;width:9px;height:9px;border-radius:5px}
  .bar i:nth-child(1){left:13px;background:#F2B8BD}.bar i:nth-child(2){left:28px;background:#F2DFA6}.bar i:nth-child(3){left:43px;background:#B6E0C8}
  .mono{font-family:${MONO};white-space:pre}
  .pill{display:inline-block;border-radius:999px;font:700 11.5px/1 ${SANS};letter-spacing:.14em;padding:8px 14px}
`;

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Collapses every run of two or more blank rows to one: a chat view keeps a tall, empty transcript above its prompt. */
function compactRows(grid) {
  const out = [];
  let blanks = 0;
  for (const row of grid) {
    const blank = row.every((c) => c.ch === ' ');
    blanks = blank ? blanks + 1 : 0;
    if (blank && blanks > 1) continue;
    out.push(row);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── hero (1280 x 560)

export function heroHtml(chatFramesPath) {
  const frames = JSON.parse(readFileSync(chatFramesPath, 'utf8'));
  const grid = compactRows(parseAnsi(frames.running.join('\n'), 80, frames.running.length));
  // drop the title that the header carries on its right: it repeats the user's row
  const chatRows = grid.map((row) => rowHtml(row)).join('');
  return `<!doctype html><meta charset="utf-8"><title>hero</title><style>${baseCss(1280, 560)}
  .b1{width:560px;height:560px;left:-160px;top:-200px;background:#E7DFFB;opacity:.95}
  .b2{width:460px;height:460px;left:830px;top:320px;background:#FCE6D8;opacity:.95}
  .b3{width:420px;height:420px;left:520px;top:-210px;background:#D9F0E6;opacity:.8}
  .b4{width:380px;height:380px;left:-90px;top:370px;background:#DCE8FB;opacity:.85}
  .left{position:absolute;left:64px;top:68px;width:520px}
  h1{margin:30px 0 22px;font:760 54px/1.1 ${SANS};letter-spacing:-.025em;color:${P.ink}}
  h1 span{display:inline;padding:0 .06em}
  .hl1{background:linear-gradient(transparent 64%,#D9CFFA 64%,#D9CFFA 94%,transparent 94%)}
  .hl2{background:linear-gradient(transparent 64%,#C9EBDC 64%,#C9EBDC 94%,transparent 94%)}
  .hl3{background:linear-gradient(transparent 64%,#FAD9C6 64%,#FAD9C6 94%,transparent 94%)}
  .sub{font:400 19px/1.55 ${SANS};color:${P.soft};max-width:470px;margin:0}
  .foot{position:absolute;left:64px;bottom:44px;font:700 11.5px/1 ${SANS};letter-spacing:.2em;color:${P.faint}}
  .chat{left:612px;top:64px;width:582px}
  .chat .term{padding:14px 18px 16px 18px;font:12px/16px ${MONO};color:${P.ink}}
  .row{height:16px;white-space:pre;display:block}
  .c{display:inline-block;width:1ch}.w{width:1ch;overflow:visible;text-align:center}
  .runs{left:932px;top:340px;width:262px}
  .runs .body{padding:10px 14px 12px;font:12px/19px ${MONO}}
  .runs .r{white-space:pre;color:${P.soft}}
  .runs .hi{background:${THEME.highlight};color:${P.ink};font-weight:700;margin:0 -14px;padding:0 14px}
  .ok{color:${P.mintDeep}}.run{color:${P.lavDeep}}
  .yaml{left:612px;top:340px;width:300px}
  .yaml .body{padding:10px 14px 12px;font:11.5px/17px ${MONO};color:${P.ink}}
  .k{color:${P.skyDeep}}.s{color:${P.mintDeep}}.d{color:${P.faint}}.g{color:${P.peachDeep}}
</style>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div>
<div class="left">
  <span class="pill" style="background:#EDE8FB;color:${P.lavText}">LOCAL-FIRST · MULTI-MODEL · GIT-NATIVE</span>
  <h1><span class="hl1">Start as an agent.</span><br><span class="hl2">Ship the workflow.</span><br><span class="hl3">Own every run.</span></h1>
  <p class="sub">Conversation becomes version-controlled automation, on one pure-TypeScript engine.</p>
</div>
<div class="foot">RELAVIUM &nbsp;·&nbsp; A HODETECH PRODUCT</div>
<div class="card chat"><div class="bar"><i></i><i></i><i></i>relavium</div><div class="term">${chatRows}</div></div>
<div class="card yaml"><div class="bar"><i></i><i></i><i></i>release-notes.relavium.yaml</div><div class="body mono"><span class="k">workflow</span><span class="d">:</span>
  <span class="k">id</span><span class="d">:</span> <span class="s">release-notes</span>
  <span class="k">nodes</span><span class="d">:</span>
    <span class="d">-</span> <span class="d">{</span> <span class="k">id</span><span class="d">:</span> start<span class="d">,</span> <span class="k">type</span><span class="d">:</span> input <span class="d">}</span>
    <span class="d">-</span> <span class="d">{</span> <span class="k">id</span><span class="d">:</span> draft<span class="d">,</span> <span class="k">type</span><span class="d">:</span> transform <span class="d">}</span>
    <span class="d">-</span> <span class="k">id</span><span class="d">:</span> approve
      <span class="k">type</span><span class="d">:</span> <span class="g">human_gate</span>
      <span class="k">gate_type</span><span class="d">:</span> <span class="s">approval</span></div></div>
<div class="card runs"><div class="bar"><i></i><i></i><i></i>Runs</div><div class="body mono"><div class="r hi">› <span class="ok">✓</span> completed  9d9575a5</div><div class="r">  <span class="ok">✓</span> completed  b89315c4</div><div class="r">  <span class="run">◐</span> running    c04e1f77</div><div class="r">  <span class="ok">✓</span> completed  71ab20d9</div></div></div>`;
}

// ───────────────────────────────────────────────────────────────────────────────────── the continuum (1280 x 440)

export function flowHtml() {
  const steps = [
    {
      n: 1,
      tint: P.lav,
      deep: P.lavDeep,
      title: 'Agent session',
      a: 'explore in conversation',
      b: 'persistent + tool-aware',
      art: `<div class="bub u">Turn my Friday steps into a workflow</div><div class="bub a">▸ read_file ✓ &nbsp;▸ grep ✓<br>This fits a workflow.</div>`,
    },
    {
      n: 2,
      tint: P.mint,
      deep: P.mintDeep,
      title: 'Proven flow',
      a: 'keep what actually works',
      b: 'decisions + structure',
      art: `<div class="chk"><b class="ok">✓</b> gather the merged changes</div><div class="chk"><b class="ok">✓</b> draft the notes</div><div class="chk"><b class="ok">✓</b> wait for approval</div>`,
    },
    {
      n: 3,
      tint: P.peach,
      deep: P.peachDeep,
      title: '.relavium.yaml',
      a: 'review, diff, commit',
      b: 'portable + git-native',
      art: `<div class="y"><span class="k">nodes</span>:<br>&nbsp; - { id: <span class="s">draft</span> }<br>&nbsp; - id: <span class="s">approve</span><br>&nbsp; &nbsp; type: <span class="g">human_gate</span></div>`,
    },
    {
      n: 4,
      tint: P.sky,
      deep: P.skyDeep,
      title: 'Own every run',
      a: 'observe and operate',
      b: 'events + history + gates',
      art: `<div class="rr hi">› <b class="ok">✓</b> completed &nbsp;9d9575a5</div><div class="rr">&nbsp; <b class="ok">✓</b> completed &nbsp;b89315c4</div><div class="rr">&nbsp; <b class="run">◐</b> running &nbsp;&nbsp;&nbsp;c04e1f77</div>`,
    },
  ];
  const arrowAfter = (i) =>
    i < steps.length - 1
      ? '<div class="arrow" style="left:' + String(48 + i * 298 + 258) + 'px">›</div>'
      : '';
  const cards = steps
    .map(
      (s, i) => `<div class="step" style="left:${48 + i * 298}px">
  <div class="num" style="background:${s.tint};color:${s.deep}">${s.n}</div>
  <div class="art" style="background:${s.tint}55;border-color:${s.tint}">${s.art}</div>
  <div class="st">${esc(s.title)}</div><div class="sa">${esc(s.a)}</div><div class="sb">${esc(s.b)}</div>
</div>${arrowAfter(i)}`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>continuum</title><style>${baseCss(1280, 440)}
  .b1{width:460px;height:460px;left:-140px;top:-190px;background:#E7DFFB;opacity:.9}
  .b2{width:420px;height:420px;left:900px;top:230px;background:#FCE6D8;opacity:.85}
  .b3{width:360px;height:360px;left:420px;top:-200px;background:#DCE8FB;opacity:.8}
  .eyebrow{position:absolute;left:0;right:0;top:34px;text-align:center;font:700 11.5px/1 ${SANS};letter-spacing:.22em;color:${P.lavText}}
  .head{position:absolute;left:0;right:0;top:58px;text-align:center;font:700 27px/1.25 ${SANS};letter-spacing:-.015em;color:${P.ink}}
  .step{position:absolute;top:128px;width:260px}
  .num{width:30px;height:30px;border-radius:15px;font:800 14px/30px ${SANS};text-align:center;margin:0 0 12px}
  .art{height:118px;border:1px solid;border-radius:14px;padding:11px 12px;font:12px/17px ${MONO};background:#fff;overflow:hidden}
  .bub{border-radius:10px;padding:6px 9px;margin-bottom:6px;white-space:normal;font:11.5px/16px ${MONO}}
  .u{background:#fff;color:${P.ink};border:1px solid ${P.line}}
  .bub.a{background:#ffffffaa;color:${P.soft}}
  .chk{color:${P.soft};white-space:nowrap;margin:2px 0}.ok{color:${P.mintDeep}}.run{color:${P.lavDeep}}
  .y{color:${P.ink};white-space:nowrap}.k{color:${P.skyDeep}}.s{color:${P.mintDeep}}.g{color:${P.peachDeep}}
  .rr{white-space:pre;color:${P.soft};margin:3px 0}.hi{background:${THEME.highlight};color:${P.ink};font-weight:700;margin:3px -12px;padding:0 12px}
  .st{font:700 17px/1.2 ${SANS};margin:16px 0 4px;color:${P.ink}}
  .sa{font:500 14px/1.35 ${SANS};color:${P.soft}}.sb{font:500 13px/1.35 ${SANS};color:${P.faint}}
  .arrow{position:absolute;top:168px;width:30px;text-align:center;font:300 30px/1 ${SANS};color:#C9C3E6}
  .foot{position:absolute;left:0;right:0;bottom:30px;text-align:center;font:700 11.5px/1 ${SANS};letter-spacing:.2em;color:${P.faint}}
</style>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
<div class="eyebrow">THE RELAVIUM CONTINUUM</div>
<div class="head">A conversation is the beginning, not the dead end.</div>
${cards}
<div class="foot">ONE ENGINE &nbsp;·&nbsp; TWO ENTRY POINTS &nbsp;·&nbsp; REPEATABLE EXECUTION</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────────────── architecture (1280 x 700)

export function architectureHtml() {
  const surfaces = [
    { n: 'CLI', d: 'terminal + CI', s: 'published', tint: P.mint, deep: P.mintDeep },
    { n: 'Desktop', d: 'Tauri management center', s: 'planned', tint: P.lav, deep: P.lavDeep },
    { n: 'VS Code', d: 'authoring + execution', s: 'planned', tint: P.sky, deep: P.skyDeep },
    { n: 'Cloud host', d: 'future workers + API', s: 'planned', tint: P.peach, deep: P.peachDeep },
  ];
  const surfaceCards = surfaces
    .map(
      (
        s,
        i,
      ) => `<div class="surf" style="left:${64 + i * 296}px;background:${s.tint}66;border-color:${s.tint}">
  <div class="sn">${esc(s.n)}</div><div class="sd">${esc(s.d)}</div>
  <span class="chip" style="background:${s.tint};color:${s.deep}">${s.s}</span></div>`,
    )
    .join('');
  const pkgs = [
    { n: '@relavium/llm', d: 'provider-neutral model seam', tint: P.lav, deep: P.lavDeep },
    { n: '@relavium/shared', d: 'Zod contracts + types', tint: P.mint, deep: P.mintDeep },
    { n: '@relavium/mcp', d: 'inbound tools + SDK fence', tint: P.sky, deep: P.skyDeep },
    { n: '@relavium/db', d: 'durable local / cloud stores', tint: P.peach, deep: P.peachDeep },
  ];
  const pkgCards = pkgs
    .map(
      (s, i) =>
        `<div class="pkg" style="left:${64 + i * 296}px;border-color:${s.tint}"><div class="pn" style="color:${s.deep}">${esc(s.n)}</div><div class="pd">${esc(s.d)}</div></div>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>architecture</title><style>${baseCss(1280, 700)}
  .b1{width:480px;height:480px;left:-150px;top:-200px;background:#E7DFFB;opacity:.9}
  .b2{width:440px;height:440px;left:900px;top:430px;background:#FCE6D8;opacity:.85}
  .b3{width:380px;height:380px;left:760px;top:-190px;background:#D9F0E6;opacity:.8}
  .label{position:absolute;left:64px;font:700 11.5px/1 ${SANS};letter-spacing:.22em;color:${P.faint}}
  .eyebrow{position:absolute;left:0;right:0;top:34px;text-align:center;font:700 11.5px/1 ${SANS};letter-spacing:.22em;color:${P.lavText}}
  .surf{position:absolute;top:96px;width:272px;height:92px;border:1px solid;border-radius:14px;padding:16px 18px}
  .sn{font:700 18px/1.2 ${SANS};color:${P.ink}}.sd{font:500 13.5px/1.4 ${SANS};color:${P.soft};margin-top:3px}
  .chip{position:absolute;right:14px;top:14px;font:700 10.5px/1 ${SANS};letter-spacing:.1em;text-transform:uppercase;border-radius:999px;padding:5px 9px}
  .core{position:absolute;left:64px;top:262px;width:1152px;height:212px;background:#fff;border:1px solid ${P.line};border-radius:20px;box-shadow:${P.shadow}}
  .core .ct{position:absolute;left:28px;top:20px;font:800 17px/1 ${MONO};color:${P.lavText}}
  .core .cs{position:absolute;right:28px;top:22px;font:700 10.5px/1 ${SANS};letter-spacing:.16em;color:${P.faint}}
  .entry{position:absolute;top:58px;width:540px;height:74px;border-radius:12px;padding:14px 18px}
  .entry b{display:block;font:700 16px/1.2 ${MONO};color:${P.ink}}.entry span{font:500 13.5px/1.4 ${SANS};color:${P.soft}}
  .band{position:absolute;left:28px;right:28px;top:150px;height:40px;border-radius:10px;background:#F4F1FB;text-align:center;font:700 11px/40px ${SANS};letter-spacing:.14em;color:${P.soft}}
  .pkg{position:absolute;top:548px;width:272px;height:78px;background:#fff;border:2px solid;border-radius:14px;padding:15px 18px;box-shadow:${P.shadow}}
  .pn{font:700 15px/1.2 ${MONO}}.pd{font:500 13px/1.4 ${SANS};color:${P.soft};margin-top:5px}
  .link{position:absolute;width:2px;background:#D8D2EE}
  .foot{position:absolute;left:0;right:0;bottom:30px;text-align:center;font:700 11.5px/1 ${SANS};letter-spacing:.2em;color:${P.faint}}
</style>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
<div class="eyebrow">SHARED-ENGINE ARCHITECTURE</div>
<div class="label" style="top:70px">SURFACES</div>
${surfaceCards}
<div class="link" style="left:640px;top:190px;height:72px"></div>
<div class="core">
  <div class="ct">@relavium/core</div><div class="cs">PURE TYPESCRIPT · ZERO PLATFORM IMPORTS</div>
  <div class="entry" style="left:28px;background:${P.lav}88"><b>AgentSession</b><span>conversational, multi-turn entry point</span></div>
  <div class="entry" style="left:584px;background:${P.mint}88"><b>WorkflowEngine</b><span>declarative DAG execution entry point</span></div>
  <div class="band">TOOL REGISTRY · TYPED EVENT BUS · CHECKPOINT / RESUME · POLICY</div>
</div>
<div class="label" style="top:512px">HOST-INJECTED CAPABILITIES + SHARED CONTRACTS</div>
<div class="link" style="left:640px;top:474px;height:36px"></div>
${pkgCards}
<div class="foot">POLICY IN CORE &nbsp;·&nbsp; MECHANISM AT THE HOST &nbsp;·&nbsp; PROVIDERS BEHIND THE SEAM</div>`;
}
