// 审查实验 17：定位 isRtkInvocation 的异常判定（"rtk' git status" 为何为 true），
// 以及 firstWord/splitSegments 的引号处理缺陷。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev17-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor { async execute(s){ return { executed: s.command }; } }
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());

// 复刻 firstWord / splitSegments 用于观察中间结果
function splitSegments(command) {
  const segments = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      segments.push(command.slice(start, i));
      while (i + 1 < command.length && '&|'.includes(command[i + 1])) i++;
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments.filter((s) => s.trim().length > 0);
}
function firstWord(segment) {
  const text = segment.trimStart();
  const quote = text[0] === '"' || text[0] === "'" ? text[0] : null;
  if (quote) {
    const close = text.indexOf(quote, 1);
    return close === -1 ? text : text.slice(1, close);
  }
  const end = text.search(/[\s;|&]/);
  return end === -1 ? text : text.slice(0, end);
}

console.log('## 异常判定定位');
for (const c of ['"rtk\' git status', "'rtk\' git status", '"rtk', "'rtk", 'rtk"', "rtk'"]) {
  const segs = splitSegments(c);
  const words = segs.map((s) => firstWord(s));
  console.log(
    '  ' + JSON.stringify(c).padEnd(22) +
      ' segments=' + JSON.stringify(segs).padEnd(26) +
      ' firstWord=' + JSON.stringify(words).padEnd(24) +
      ' isRtkInvocation=' + mod.isRtkInvocation(c),
  );
}

console.log('\n## 引号未闭合 / 跨段引号 的漏判（危险方向：误判为 rtk → 跳过改写，安全；误判为非 rtk → 多一次 spawn，安全）');
const QUOTE_CASES = [
  'echo "a;rtk git status"',
  'echo "a && rtk git status"',
  "echo 'a; rtk git status'",
  'echo "unclosed ; rtk git status',
  'rtk git status "unclosed',
  'rtk git status\'x"',
];
for (const c of QUOTE_CASES) {
  console.log('  ' + JSON.stringify(c).padEnd(38) + ' segments=' + JSON.stringify(splitSegments(c)).padEnd(52) + ' guard=' + mod.isRtkInvocation(c));
}

console.log('\n## PowerShell 特有分隔符（; 全角 / 反引号转义 / # 注释）');
for (const c of ['rtk git status；ls', 'rtk git status `; ls', 'rtk git status # ; ls', 'rtk git status\nls']) {
  console.log('  ' + JSON.stringify(c).padEnd(32) + ' guard=' + mod.isRtkInvocation(c) + ' segments=' + JSON.stringify(splitSegments(c)));
}

rmSync(TMP, { recursive: true, force: true });
