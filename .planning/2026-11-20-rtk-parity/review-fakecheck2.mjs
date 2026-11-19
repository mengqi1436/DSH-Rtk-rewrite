import { execFileSync } from 'node:child_process';
const cases = ['git status','ls -la','git status && git log','git status; git log','git status || git log','rtk git status','rtk','  rtk git status','FOO=1 git status','cat -n f.txt','git status | head -5'];
function fake(cmd) { const t = cmd.trim(); const is = t === 'rtk' || t.startsWith('rtk '); return (is ? t : 'rtk ' + cmd); }
function real(cmd) {
  try { return { code: 0, out: execFileSync('rtk', ['rewrite', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '').trim() }; }
}
let diff = 0;
for (const c of cases) {
  const f = fake(c); const r = real(c);
  const same = f === r.out;
  if (!same) diff++;
  console.log((same ? 'same ' : 'DIFF '), JSON.stringify(c).padEnd(28), 'fake=' + JSON.stringify(f).padEnd(36), 'real(exit ' + r.code + ')=' + JSON.stringify(r.out));
}
console.log('差异条数', diff, '/', cases.length);