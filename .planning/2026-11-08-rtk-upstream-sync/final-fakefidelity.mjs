// 终审实验 12：E1a 的假 rtk 对 leading-dash 的建模 vs 真 rtk 0.49.0 的实际行为。
// 若假 rtk 比真 rtk 更严格（假设 clap 吃掉任何 leading-dash），是"过严建模"，
// 会使测试更强而非更弱 —— 但必须写明，避免有人拿它推断真 rtk 行为。
import { execFile } from 'node:child_process';

const CASES = ['-h', '--help', '-hh', '-v', '--version', '--', '--skip-env', '-help', '--HELP', '-H', '-x ls'];

function real(args) {
  return new Promise((r) => {
    execFile('rtk', args, { timeout: 10000, windowsHide: true }, (e, o) => r({ code: e ? e.code : 0, out: String(o || '') }));
  });
}

// 假 rtk 的建模（与 test.js:80-88 一致）：
//   cmd.startsWith('-') && !isolated → help 到 stdout + exit 0
//   cmd.startsWith('-') && isolated  → exit 1
function fake(cmd, isolated) {
  if (cmd.startsWith('-')) {
    if (!isolated) return { code: 0, isHelp: true };
    return { code: 1, isHelp: false };
  }
  return { code: 3, isHelp: false };
}

// 插件当前行为：startsWith('-') → 加 --
function pluginArgs(cmd) {
  return cmd.startsWith('-') ? ['rewrite', '--', cmd] : ['rewrite', cmd];
}

console.log('## 假 rtk 建模 vs 真 rtk 实测（无 -- 隔离时）');
console.log('命令'.padEnd(14) + '| 假rtk(未隔离) | 真rtk(未隔离) | 是否一致');
for (const c of CASES) {
  const f = fake(c, false);
  const t = await real(['rewrite', c]);
  const tIsHelp = /Rewrite a raw command|Usage:/.test(t.out);
  const same = f.code === t.code && f.isHelp === tIsHelp;
  console.log(
    JSON.stringify(c).padEnd(14) +
      '| exit=' + String(f.code).padEnd(2) + ' help=' + String(f.isHelp).padEnd(5) +
      ' | exit=' + String(t.code).padEnd(2) + ' help=' + String(tIsHelp).padEnd(5) +
      ' | ' + (same ? '一致' : '★不一致'),
  );
}

console.log('\n## 有 -- 隔离时（插件当前实际传入）');
console.log('命令'.padEnd(14) + '| 假rtk(隔离) | 真rtk(-- 隔离) | 是否一致');
let isoDiff = 0;
for (const c of CASES) {
  const f = fake(c, true);
  const t = await real(['rewrite', '--', c]);
  const tIsHelp = /Rewrite a raw command|Usage:/.test(t.out);
  const same = f.code === t.code && f.isHelp === tIsHelp;
  if (!same) isoDiff++;
  console.log(
    JSON.stringify(c).padEnd(14) +
      '| exit=' + String(f.code).padEnd(2) + ' help=' + String(f.isHelp).padEnd(5) +
      ' | exit=' + String(t.code).padEnd(2) + ' help=' + String(tIsHelp).padEnd(5) +
      ' | ' + (same ? '一致' : '★不一致'),
  );
}

console.log('\n## 结论');
console.log('  有 -- 隔离时不一致数 = ' + isoDiff + '（' + (isoDiff === 0 ? '假 rtk 与真 rtk 完全一致' : '存在差异') + '）');
console.log('  无 -- 时若假 rtk 比真 rtk 更"危险"（更多 help），则 E1a 是过严建模 —— 测试更强，不会假绿。');
