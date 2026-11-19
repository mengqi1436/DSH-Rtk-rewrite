import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';
const SP = ' '; const LF = String.fromCharCode(10); const TAB = String.fromCharCode(9);
const CASES = ['rtk git status' + SP, 'rtk' + SP, '  rtk git status', 'rtk git status' + LF, TAB + 'rtk git status', 'rtk git status  ' + LF, '  rtk', 'rtk git status && rtk git log' + SP];
for (const c of CASES) {
  let code = -1, out = '';
  try { out = execFileSync('rtk', ['rewrite', c], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); code = 0; }
  catch (e) { code = e.status ?? -1; out = String(e.stdout || '').trim(); }
  const skip = isRtkInvocation(c);
  const hasDouble = /(^|\s)rtk\s+rtk(\s|$)/.test(out);
  console.log('skip=' + String(skip).padEnd(6), 'exit=' + String(code).padEnd(2), 'double=' + String(hasDouble).padEnd(6), JSON.stringify(c).padEnd(34), '->', JSON.stringify(out));
}
