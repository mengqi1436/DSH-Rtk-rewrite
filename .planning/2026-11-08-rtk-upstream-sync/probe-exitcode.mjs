// 审查实验 8：证明「非白名单退出码 + 有 stdout」会被当成改写结果执行（P0）。
// 以及 maxBuffer 截断输出被当成改写结果的路径。
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// index.js 现行 rtkRewrite（逐字复制语义）
function rtkRewriteWith(bin, command) {
  return new Promise((resolve) => {
    execFile(bin, ['rewrite', command], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '').trim();
      if (!err) { resolve(out || null); return; }
      if (err.code === 'ENOENT') { /* warn */ }
      else if (err.killed) { /* warn */ }
      else if (Number(err.code) === 1) { /* silent */ }
      else if (out) { resolve(out); return; }
      else { /* warn */ }
      resolve(null);
    });
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'rtkfake-'));

// 假 rtk：模拟各种退出码 + stdout 组合。用 node 脚本当"rtk"。
function makeFake(name, exitCode, stdout, stderr) {
  const p = path.join(dir, name + '.mjs');
  writeFileSync(p, `
process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${exitCode});
`);
  return p;
}
// 用 node 作为解释器不可行（execFile 直接跑脚本需 shebang）。改用 .cmd 包装。
function makeFakeCmd(name, exitCode, stdout, stderr) {
  const js = path.join(dir, name + '.mjs');
  writeFileSync(js, `process.stdout.write(${JSON.stringify(stdout)});\nif (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${exitCode});\n`);
  const cmd = path.join(dir, name + '.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  return cmd;
}

const SCEN = [
  ['exit2 无输出（rtk deny，契约内）', 2, '', ''],
  ['exit2 带 stdout（未来 rtk 打印 deny 原因）', 2, 'BLOCKED: rm -rf denied by rule', ''],
  ['exit4 带 stdout（未知新码）', 4, 'rtk git status', ''],
  ['exit0 带 stdout', 0, 'rtk git status', ''],
  ['exit3 带 stdout', 3, 'rtk git status', ''],
  ['exit3 带 stderr 警告 + stdout', 3, 'rtk git status', 'warning: something'],
  ['exit1 带 stdout（契约外）', 1, 'rtk git status', ''],
];

console.log('# 场景 | rtkRewrite 返回 | 是否会被替换执行');
for (const [label, code, out, errText] of SCEN) {
  const bin = makeFakeCmd('fake' + code + '_' + label.length, code, out, errText);
  const r = await rtkRewriteWith(bin, 'git status');
  const replaced = !!r && r !== 'git status';
  console.log(label.padEnd(44) + ' | ' + JSON.stringify(r).padEnd(48) + ' | replace=' + replaced);
}

// maxBuffer 截断路径：让假 rtk 输出 2MB
console.log('\n# maxBuffer 截断路径');
const bigOut = 'rtk ' + 'x'.repeat(2 * 1024 * 1024);
const binBig = makeFakeCmd('big', 0, bigOut, '');
const rBig = await rtkRewriteWith(binBig, 'git status');
console.log(
  'exit0 + 2MB stdout -> 返回长度=' + (rBig === null ? 'null' : rBig.length) +
    ' 幂等?=' + (rBig === bigOut) + ' 会被替换?=' + (!!rBig && rBig !== 'git status'),
);
