import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const BT = String.fromCharCode(96);

const CASES = [
  'rtk git status' + CR,
  'rtk git status' + CR + LF,
  CR + LF + ' rtk git status',
  'rtk' + TAB + 'git status',
  '# rtk git status',
  'rtk git status # x',
  '$(' + 'rtk git status)',
  BT + 'rtk git status' + BT,
  'rtk git status 2>&1',
  'rtk git status > f',
  '{ rtk git status; }',
  '( rtk ls )',
  'if true; then rtk ls; fi',
  'A=1 B=2 rtk ls',
  'rtk ls && rtk grep "a|b"',
  LF + '  rtk ls',
  'rtk git status; ls',
  'ls; rtk git status',
  'rtk git status & rtk ls',
  'rtk git status |& rtk ls',
  'rtk git status' + CR + LF + 'ls',
  'RTK_DISABLED=1 rtk ls',
  'rtk' + LF + 'ls',
];

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const out = [];
for (const c of CASES) {
  let code = -1, so = '';
  try {
    so = execFileSync('rtk', ['rewrite', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    code = 0;
  } catch (e) {
    code = e.status ?? -1;
    so = String(e.stdout || '').trim();
  }
  const skip = isRtkInvocation(c);
  const wouldRewrite = (code === 0 || code === 3) && so !== '' && so !== c;
  const realDiv = skip && wouldRewrite && norm(so) !== norm(c);
  out.push({ cmd: c, skip, code, rtkOut: so, wouldRewrite, realDiv });
}
console.log(JSON.stringify({
  total: out.length,
  skipCount: out.filter(r => r.skip).length,
  realDivergence: out.filter(r => r.realDiv),
  rows: out,
}, null, 1));
