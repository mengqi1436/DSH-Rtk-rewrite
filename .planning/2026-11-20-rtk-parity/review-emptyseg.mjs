import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';
const CASES = ['rtk git status;;', 'rtk git status &&', 'rtk git status ||', '&& rtk git status', 'rtk git status && && rtk ls', 'rtk;rtk', 'rtk&&rtk', 'rtk  git  status', 'rtk git status\n\nrtk ls'];
const norm = (s) => s.replace(/\s+/g, ' ').trim();
for (const c of CASES) {
  let code = -1, out = '';
  try { out = execFileSync('rtk', ['rewrite', c], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); code = 0; }
  catch (e) { code = e.status ?? -1; out = String(e.stdout || '').trim(); }
  const skip = isRtkInvocation(c);
  const real = skip && (code === 0 || code === 3) && out !== '' && norm(out) !== norm(c);
  console.log((real ? 'REAL-DIV' : '        '), 'skip=' + String(skip).padEnd(5), 'exit=' + String(code).padEnd(2), JSON.stringify(c).padEnd(30), '->', JSON.stringify(out));
}
