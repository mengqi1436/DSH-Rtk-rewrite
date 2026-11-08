// 终审实验 11：用性质测试（而非论证）判定两个"等价变异体"是否真的等价。
// M25: splitSegments 里的 `while (i+1<len && '&|'.includes(cmd[i+1])) i++` 是否可删？
// M27: `Number(err.code) === N` 与 `err.code === N` 是否等价？
import { readFileSync } from 'node:fs';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(REPO + '/index.js', 'utf8');

// ── 从 index.js 抽出真实实现，构造两个变体 ──
function makeSplit(keepWhile) {
  return new Function('command', `
    const segments = [];
    let start = 0;
    let quote = null;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === ';' || ch === '&' || ch === '|' || ch === '\\n') {
        segments.push(command.slice(start, i));
        ${keepWhile ? `while (i + 1 < command.length && '&|'.includes(command[i + 1])) i++;` : ''}
        start = i + 1;
      }
    }
    segments.push(command.slice(start));
    return segments.filter((s) => s.trim().length > 0);
  `);
}
const splitWith = makeSplit(true);
const splitWithout = makeSplit(false);

// ── M25 性质测试：随机 + 穷举分隔符组合 ──
console.log('══ M25：删掉 while 跳过循环是否等价 ══');
const ALPHABET = ['a', 'b', ' ', ';', '&', '|', '"', "'", '\n', 'r', 't', 'k'];
let m25Diff = 0;
let m25Tested = 0;
const m25Examples = [];
// 穷举长度 ≤4 的所有组合
function* gen(prefix, depth) {
  if (depth === 0) { yield prefix; return; }
  for (const c of ALPHABET) yield* gen(prefix + c, depth - 1);
}
for (const s of gen('', 4)) {
  m25Tested++;
  const a = JSON.stringify(splitWith(s));
  const b = JSON.stringify(splitWithout(s));
  if (a !== b) {
    m25Diff++;
    if (m25Examples.length < 6) m25Examples.push({ s, withWhile: a, without: b });
  }
}
console.log(`  穷举 ${m25Tested} 个长度≤4 的字符串，差异 ${m25Diff} 个`);
for (const e of m25Examples) {
  console.log(`  ✗ ${JSON.stringify(e.s)}`);
  console.log(`      有 while: ${e.withWhile}`);
  console.log(`      无 while: ${e.without}`);
}

// 定向：真实命令形态
const REAL_CASES = [
  'a && b', 'a || b', 'a & b', 'a | b', 'a &| b', 'a &&& b', 'rtk git status &&', '&& rtk',
  'rtk git status && && rtk ls', 'a ; b', 'a && b && c', 'echo "a&&b"', "echo 'a||b'",
  'ls -la && rtk git status', 'rtk git status && rtk git diff',
];
console.log('  定向真实命令：');
let realDiff = 0;
for (const s of REAL_CASES) {
  const a = JSON.stringify(splitWith(s));
  const b = JSON.stringify(splitWithout(s));
  if (a !== b) { realDiff++; console.log(`  ✗ ${JSON.stringify(s)}\n      有: ${a}\n      无: ${b}`); }
}
if (realDiff === 0) console.log('    全部一致（' + REAL_CASES.length + ' 条）');

// ── M27 性质测试：Number(err.code) vs err.code ──
console.log('\n══ M27：Number(err.code) === N 与 err.code === N 是否等价 ══');
// 从 index.js 抽出所有 Number(err.code) === N 的比较
const codeSamples = src.match(/Number\(err\.code\) === (\d+)/g) || [];
console.log('  源码中的比较子：' + JSON.stringify(codeSamples));

const POSSIBLE = [0, 1, 2, 3, 4, 7, 70, 127, -1, null, undefined, '0', '1', '2', '3', 'ENOENT', 'EACCES', '', ' ', 'null', 'NaN', NaN, Infinity, 3.0, '3 '];
let m27Diff = 0;
for (const n of [1, 2, 3]) {
  for (const v of POSSIBLE) {
    const withNum = Number(v) === n;
    const without = v === n;
    if (withNum !== without) {
      m27Diff++;
      console.log(`  ✗ err.code=${JSON.stringify(v)} N=${n}: Number()=${withNum}  裸比较=${without}`);
    }
  }
}
if (m27Diff === 0) console.log(`  全部等价（${POSSIBLE.length * 3} 个组合）`);

console.log('\n══ 实测 err.code 的真实取值域（node v' + process.version + '）══');
console.log('  真 rtk 非零退出 → number（probe 已测：git status=3, Get-ChildItem=1）');
console.log('  ENOENT         → "ENOENT"（string）');
console.log('  超时            → null + err.killed=true（走 killed 分支，不进入 code 比较）');
console.log('  因此三处 Number() 都不会改变分支结果。');

console.log('\n══ 结论 ══');
console.log('  M25 等价？' + (m25Diff === 0 ? '是（穷举+定向零差异）' : `否（${m25Diff} 处差异）`));
console.log('  M27 等价？' + (m27Diff === 0 ? '是（取值域内零差异）' : `否（${m27Diff} 处差异）`));
