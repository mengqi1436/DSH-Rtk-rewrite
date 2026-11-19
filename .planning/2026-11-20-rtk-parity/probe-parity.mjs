import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

const CASES = [
  'git status', 'ls -la', 'git status && git log', 'git status; git log',
  'git status || git log', 'git status & git log', 'git status | head -5',
  'sleep 1 & git status', 'echo "a && b" && git status',
  'FOO=1 git status', 'FOO="a b" git status', 'RTK=1 git status', 'rtk=1 ls', 'rtk=1 git status',
  'docker exec mycontainer git status', 'poetry run pytest', 'bundle exec rspec',
  'bundle exec rtk git status', 'poetry run rtk git status', 'env rtk git status',
  'rtk', 'rtk git status', '  rtk git status', 'rtk.exe git status',
  'rtk ls -la', 'rtk ls | head -5', 'rtk git status | rtk grep foo',
  'rtk git status && rtk git log', 'rtk git status; rtk ls', 'rtk git status && git log',
  'RTK_DISABLED=1 git status', 'sudo rtk git status', 'rtkx git status', 'rtk-helper git status',
  'git status # rtk comment', 'Get-ChildItem', 'cat -v f.txt', 'cat -n f.txt',
  'if true; then git status; fi', 'for f in *; do git status; done',
  'rtk gain', 'rtk rewrite "git status"', 'RTK_BIN=rtk git status',
  'RTK_DISABLED=1 rtk git status', 'FOO=1 rtk git status',
  'ls && rtk git status', 'rtk git status || ls',
];

function rtkRewrite(cmd) {
  try {
    const out = execFileSync('rtk', ['rewrite', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || '').trim() };
  }
}

const rows = [];
for (const cmd of CASES) {
  const skip = isRtkInvocation(cmd);
  const r = rtkRewrite(cmd);
  const rtkWouldRewrite = (r.code === 0 || r.code === 3) && r.out && r.out !== cmd;
  // 分歧定义：插件跳过(不 spawn) 但 rtk 其实会改写；或 插件不跳过 但 rtk 无改写(仅多一次 spawn，无害)
  const divergence = skip && rtkWouldRewrite;
  rows.push({ cmd, skip, code: r.code, out: r.out, rtkWouldRewrite, divergence });
}

const diverged = rows.filter(x => x.divergence);
console.log('总用例:', rows.length, '| 分歧(漏改写):', diverged.length);
console.log('--- 分歧明细（插件跳过但 rtk 会改写）---');
for (const d of diverged) console.log(JSON.stringify(d));
console.log('--- 全部明细 ---');
for (const x of rows) console.log((x.divergence ? 'DIV ' : '    ') + String(x.skip).padEnd(5), 'exit=' + String(x.code).padEnd(3), JSON.stringify(x.cmd), '->', JSON.stringify(x.out));
