import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const points = [];
// Unicode White_Space 全表 + 常见零宽/BOM
const WS = [0x09,0x0A,0x0B,0x0C,0x0D,0x20,0x85,0xA0,0x1680,0x2000,0x2001,0x2002,0x2003,0x2004,0x2005,0x2006,0x2007,0x2008,0x2009,0x200A,0x2028,0x2029,0x202F,0x205F,0x3000,0xFEFF,0x180E,0x200B];
const rows = [];
for (const cp of WS) {
  const ch = String.fromCodePoint(cp);
  for (const [label, c] of [['lead', ch + 'rtk git status'], ['trail', 'rtk git status' + ch], ['lead-ls', ch + 'rtk ls']]) {
    let code = -1, out = '';
    try { out = execFileSync('rtk', ['rewrite', c], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); code = 0; }
    catch (e) { code = e.status ?? -1; out = String(e.stdout || '').trim(); }
    const skip = isRtkInvocation(c);
    const wouldRewrite = (code === 0 || code === 3) && out !== '' && out !== c;
    const realDiv = skip && wouldRewrite && norm(out) !== norm(c);
    const jsTrim = c !== c.trim();
    rows.push({ cp: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'), label, skip, code, out, jsTrim, realDiv });
  }
}
const bad = rows.filter(r => r.realDiv);
console.log('测点数', rows.length, '| 真实漏改写', bad.length);
if (bad.length) { console.log('=== 真实漏改写明细 ==='); for (const b of bad) console.log(JSON.stringify(b)); }
console.log('=== 逐码点：JS trim 是否移除 / rtk 是否改写 ===');
for (const r of rows.filter(x => x.label === 'lead')) {
  console.log(r.cp, 'jsTrim=' + String(r.jsTrim).padEnd(6), 'skip=' + String(r.skip).padEnd(6), 'rtkExit=' + String(r.code).padEnd(3), 'out=' + JSON.stringify(r.out), r.realDiv ? '  <<< REAL-DIV' : '');
}
