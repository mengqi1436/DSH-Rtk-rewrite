import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = process.cwd();
const DIR = path.join(ROOT, '.planning/2026-11-20-rtk-parity/fakecheck');
mkdirSync(DIR, { recursive: true });
const cases = ['git status','ls -la','git status && git log','git status; git log','git status || git log','rtk git status','rtk','  rtk git status','FOO=1 git status','cat -n f.txt','git status | head -5'];
// 从 test.js 抽取 fake rtk exit3 分支逻辑（最新版）
const LF = String.fromCharCode(10);
function fake(cmd) { const t = cmd.trim(); const isRtkForm = t === 'rtk' || t.startsWith('rtk '); return (isRtkForm ? t : 'rtk ' + cmd); }
function real(cmd) { try { return execFileSync('rtk', ['rewrite', '--', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); } catch { return ''; } }
let diff = 0;
for (const c of cases) {
  const f = fake(c), r = real(c);
  const same = f === r;
  if (!same) diff++;
  console.log((same ? 'same ' : 'DIFF '), JSON.stringify(c).padEnd(28), 'fake=' + JSON.stringify(f).padEnd(34), 'real=' + JSON.stringify(r));
}
console.log('差异条数', diff, '/', cases.length);