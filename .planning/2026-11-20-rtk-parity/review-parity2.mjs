import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

// 审查用：不依赖 probe-parity.mjs 的 47 条固定表，专门构造「插件判 skip=true」的
// 边界写法，问 rtk 自己会不会实质改写。若 rtk 输出与原命令不等价（不是仅仅去前导
// 空白），说明插件跳过会造成真实漏改写。
const CASES = [
  // 引号包裹的首词（rtk 字面守卫不认引号）
  '"rtk" git status', "'rtk' git status", '"rtk.exe" git status',
  '"C:/Users/Sjc/.local/bin/rtk.exe" git status',
  '"/usr/local/bin/rtk" git status',
  // 路径形态
  './rtk git status', '../bin/rtk git status', '/usr/local/bin/rtk git status',
  'rtk.exe git status', 'RTK.EXE git status', 'Rtk git status', 'RTK git status',
  // ENV 前缀
  'FOO=1 rtk git status', 'RTK_DISABLED=1 rtk git status', 'A=1 B=2 rtk ls',
  'rtk=1 git status',
  // 纯 rtk 复合（插件判 true）
  'rtk', 'rtk && rtk', 'rtk;rtk', 'rtk||rtk', 'rtk && rtk ls', 'rtk\nrtk',
  'rtk git status && rtk git log', 'rtk git status; rtk ls',
  'rtk git status | rtk grep foo', 'rtk git status\nrtk git log',
  // 透明前缀 + rtk（lead 已定论 exit 1，这里复核）
  'uv run rtk git status', 'timeout 30 rtk git status', 'time rtk git status',
  'nice rtk git status', 'noglob rtk git status', 'command rtk git status',
  'exec rtk git status', 'nocorrect rtk git status', 'builtin rtk git status',
  'sudo rtk git status', 'env rtk git status',
  'bundle exec rtk git status', 'poetry run rtk git status',
  // 前后空白 / 制表符 / CR
  '  rtk git status', '\t rtk git status', '   rtk', ' rtk ',
  // 引号内分隔符
  'rtk grep "foo;bar"', 'rtk grep "a&&b"', 'rtk rg "x|y"',
  // 大小写 / 无空格
  'rtk  git  status', 'rtk\tgit status',
];

function rtkRewrite(cmd) {
  try {
    const out = execFileSync('rtk', ['rewrite', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    return { code: 0, out: out.trim(), err: '' };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || '').trim(), err: String(e.stderr || '').trim() };
  }
}

// 规范化：仅去掉前导/尾随空白与连续空白折叠，用于判「是否只是排版差异」
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const rows = [];
for (const cmd of CASES) {
  const skip = isRtkInvocation(cmd);
  const r = rtkRewrite(cmd);
  const wouldRewrite = (r.code === 0 || r.code === 3) && r.out && r.out !== cmd;
  // 真实漏改写：插件跳过，而 rtk 给出的输出与「原命令」规范化后不同
  const realDivergence = skip && wouldRewrite && norm(r.out) !== norm(cmd);
  rows.push({ cmd, skip, code: r.code, out: r.out, wouldRewrite, realDivergence });
}

console.log('用例数:', rows.length, '| 插件跳过:', rows.filter(r => r.skip).length, '| 真实漏改写:', rows.filter(r => r.realDivergence).length);
console.log('--- 插件跳过 且 rtk 有输出 ---');
for (const r of rows.filter(x => x.skip && x.out)) {
  console.log((r.realDivergence ? 'REAL-DIV ' : 'format-only ') + 'exit=' + r.code + ' ' + JSON.stringify(r.cmd) + ' -> ' + JSON.stringify(r.out));
}
console.log('--- 插件跳过 且 rtk exit 1（无改写，一致）---');
for (const r of rows.filter(x => x.skip && !x.out)) console.log('  exit=' + r.code + ' ' + JSON.stringify(r.cmd));
console.log('--- 插件不跳过（多一次 spawn，安全）---');
for (const r of rows.filter(x => !x.skip)) console.log('  exit=' + r.code + ' ' + JSON.stringify(r.cmd) + ' -> ' + JSON.stringify(r.out));
