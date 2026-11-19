import { execFileSync } from 'node:child_process';
const LF = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const CASES = [
  'git status & git log',
  'sleep 1 & git status',
  'git status |& git log',
  'git status;;git log',
  '{ git status; }',
  '(git status)',
  'git status 2>&1',
  'cat -v f.txt',
  'cat -n f.txt',
  'if true; then git status; fi',
  'git status ' + BS + LF + 'git log',
  'git status' + LF + 'git log',
];
for (const c of CASES) {
  let code = -1, out = '';
  try { out = execFileSync('rtk', ['rewrite', c], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); code = 0; }
  catch (e) { code = e.status ?? -1; out = String(e.stdout || '').trim(); }
  console.log('exit=' + String(code).padEnd(2), JSON.stringify(c).padEnd(40), '->', JSON.stringify(out));
}
