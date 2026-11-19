import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

const C = [
  // 基础
  'git status','ls -la','git log --oneline -5','docker ps','cargo test','kubectl get pods',
  // 复合/管道/后台/多行
  'git status && git log','git status || git log','git status; git log','git status & git log',
  'sleep 1 & git status','git status | head -5','ls | wc -l','git log | wc -l','git status |& git log',
  'git status;;git log','git status ;;& git log','git status\ngit log','git log\ngit status',
  'git status && git log && ls','ls && git status','git status || ls',
  // 空白
  '  rtk git status','\trtk git status','rtk git status ','rtk git status  ','\nrtk git status',
  'rtk git status\n',' rtk','rtk ','  rtk  ','rtk',
  // 纯 rtk
  'rtk git status','rtk ls -la','rtk gain','rtk rewrite "git status"','rtk.exe git status',
  './rtk git status','RTK git status','Rtk git status','RtK git status',
  '/c/Users/Sjc/.local/bin/rtk.exe git status','C:/Users/Sjc/.local/bin/rtk.exe git status',
  '"rtk" git status',"'rtk' git status",'"  rtk" git status',
  'FOO=1 rtk git status','RTK_DISABLED=1 rtk git status','A=1 B=2 rtk git status',
  'rtk=1 ls','rtk=1 git status','rtkx git status','rtk-helper git status','rtkfoo',
  'sudo rtk git status','sudo git status','rtk git status && git log','rtk git status || ls',
  'rtk git status; rtk ls','rtk git status | rtk grep foo','rtk git status\nrtk git log',
  'rtk git status\r\nrtk git log','rtk git status\r\ngit log','git status\r\nrtk git log',
  // 透明前缀
  'uv run pytest','uv run git status','uv run rtk git status','uv run rtk pytest',
  'timeout 30 git status','timeout 30 rtk git status','time git status','time rtk git status',
  'nice git status','nice rtk git status','nice -n 5 rtk git status',
  'noglob git status','noglob rtk git status','command git status','command rtk git status',
  'builtin echo hi','builtin rtk git status','exec git status','exec rtk git status',
  'nocorrect git status','nocorrect rtk git status','direnv exec . git status',
  'bundle exec rspec','bundle exec rtk git status','poetry run rtk git status','env rtk git status',
  'env FOO=1 git status','GIT_PAGER=cat git status',
  // 拒绝改写
  'echo $(git status)','git status > out.txt','git status >> out.txt','{ git status; }','(git status)',
  'if true; then git status; fi','for f in *; do git status; done','echo $$','echo $((1+1))',
  "echo 'unbalanced",'cat -v f.txt','cat -n f.txt','git status 2>&1','git status 2>/dev/null',
  'Get-ChildItem','get-childitem','Write-Output hi','echo hi','env',
  'git status # rtk comment','git commit -m "fix && update"',
];

function rtk(cmd) {
  try {
    const out = execFileSync('rtk', ['rewrite', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    return { code: 0, out: out.trim() };
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '').trim() }; }
}

let violations = 0, extraSpawn = 0;
const bad = [];
for (const cmd of C) {
  const skip = isRtkInvocation(cmd);
  const r = rtk(cmd);
  const rewrites = (r.code === 0 || r.code === 3) && r.out && r.out !== cmd;
  if (skip && rewrites) { violations++; bad.push({ cmd, code: r.code, out: r.out }); }
  else if (!skip && !rewrites) extraSpawn++;
}
console.log('用例总数:', C.length);
console.log('不变式违规(插件跳过但 rtk 会改写):', violations);
console.log('多一次 spawn(插件不跳但 rtk 无改写,无害):', extraSpawn);
if (bad.length) for (const b of bad) console.log('  VIOLATION', JSON.stringify(b));
console.log(violations === 0 ? 'RESULT: 不变式成立' : 'RESULT: 不变式被破坏');
process.exit(violations === 0 ? 0 : 1);
