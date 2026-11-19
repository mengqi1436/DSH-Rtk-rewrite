/**
 * 不变式对拍：插件「跳过」集合必须 ⊆ rtk「不改写」集合。
 *
 * 判定口径与 probe-parity.mjs 一致：
 *   skip        = isRtkInvocation(cmd)                     —— 插件不 spawn rtk
 *   rtkRewrites = (exit ∈ {0,3}) && stdout 非空 && stdout ≠ cmd  —— rtk 真的改写了命令文本
 *   违规        = skip && rtkRewrites                       —— 插件跳过了一次真实改写 = 漏改写
 *
 * 目标：违规 = 0。反向情况（插件不跳过但 rtk 无改写）只多一次 spawn，无害，单独计数。
 *
 * 用法：node .planning/2026-11-20-rtk-parity/impl-parity-invariant.mjs
 */
import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

const CASES = [
  // ── 普通命令（插件必须不跳过）──
  'git status', 'ls -la', 'cargo test --all', 'cat -n f.txt', 'Get-ChildItem',
  // ── 复合 / 管道 / 后台 / 多行（rtk 逐段改写）──
  'git status && git log', 'git status || git log', 'git status; git log',
  'git status & git log', 'sleep 1 & git status', 'git status | head -5',
  'ls && rtk git status', 'rtk git status || ls', 'rtk git status && git log',
  'git status\ngit log', 'echo "a && b" && git status',
  // ── 前导 / 尾随空白（本次修法重点）──
  ' rtk git status', '  rtk git status', '\trtk git status',
  'rtk git status ', 'rtk git status  ', 'rtk git status\n', '\nrtk git status',
  ' rtk', 'rtk ', '  rtk git status && git log', '  ls && rtk git status',
  'ls &&   rtk git status',
  // ── 纯 rtk 调用（插件必须跳过，rtk 恒等回吐或 exit 1）──
  'rtk', 'rtk git status', 'rtk ls -la', 'rtk gain', 'rtk rewrite "git status"',
  'rtk git status && rtk git log', 'rtk git status; rtk ls',
  'rtk git status | rtk grep foo', 'rtk grep "a;b" && rtk ls',
  // ── 宽判 1：大小写不敏感 ──
  'RTK git status', 'Rtk Git Status', 'RTK.EXE git status',
  // ── 宽判 2：basename 归一 ──
  './rtk git status', '/usr/local/bin/rtk git status', 'rtk.exe git status',
  'C:/Users/Sjc/.local/bin/rtk.exe git status', '"rtk" git status',
  // ── 宽判 3：env 前缀剥离 ──
  'FOO=1 rtk git status', 'RTK_DISABLED=1 rtk git status', 'RTK_BIN=rtk rtk git status',
  // ── 透明前缀（插件必须不跳过）──
  'uv run pytest', 'uv run git status', 'uv run rtk git status',
  'timeout 30 git status', 'timeout 30 rtk git status',
  'time git status', 'time rtk git status', 'nice git status', 'nice rtk git status',
  'noglob git status', 'noglob rtk git status', 'command git status', 'command rtk git status',
  'builtin rtk git status', 'exec git status', 'exec rtk git status', 'nocorrect rtk git status',
  // ── 双方都判「不是 rtk 调用」──
  'rtk=1 ls', 'rtk=1 git status', 'rtkx git status', 'rtk-helper git status',
  'sudo rtk git status', 'direnv exec . rtk git status',
  'bundle exec rtk git status', 'poetry run rtk git status', 'env rtk git status',
  'echo "rtk git status"', 'git status # rtk comment',
];

function run(cmd) {
  try {
    const out = execFileSync('rtk', ['rewrite', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || '').trim() };
  }
}

const rows = [];
for (const cmd of CASES) {
  const skip = isRtkInvocation(cmd);
  const r = run(cmd);
  const rtkRewrites = (r.code === 0 || r.code === 3) && r.out !== '' && r.out !== cmd;
  rows.push({ cmd, skip, code: r.code, out: r.out, rtkRewrites, violation: skip && rtkRewrites });
}

const violations = rows.filter((x) => x.violation);
const extraSpawns = rows.filter((x) => !x.skip && !x.rtkRewrites);

console.log('用例总数:', rows.length);
console.log('不变式违规（插件跳过但 rtk 会改写）:', violations.length);
console.log('多一次 spawn（插件不跳过但 rtk 无改写，无害）:', extraSpawns.length);
if (violations.length) {
  console.log('--- 违规明细 ---');
  for (const v of violations) console.log('  VIO', JSON.stringify(v.cmd).padEnd(44), 'exit=' + v.code, '->', JSON.stringify(v.out));
}
console.log('--- 跳过的用例（插件判定已是 rtk 调用）---');
for (const x of rows.filter((r) => r.skip)) {
  console.log('  SKIP', JSON.stringify(x.cmd).padEnd(44), 'exit=' + String(x.code).padEnd(3), '->', JSON.stringify(x.out));
}
console.log(violations.length === 0 ? 'RESULT: 不变式成立（插件跳过集合 ⊆ rtk 不改写集合）' : 'RESULT: 不变式被破坏');
process.exitCode = violations.length === 0 ? 0 : 1;
