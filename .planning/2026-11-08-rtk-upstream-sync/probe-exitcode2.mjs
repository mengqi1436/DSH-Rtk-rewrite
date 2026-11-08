// 审查实验 8b：退出码契约判定逻辑（用 node 假 rtk 精确控制 exit code + stdout）。
// 直接复刻 index.js 的 rtkRewrite 判定，只把进程换成可控假实现。
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function judge(bin, args, opts) {
  return new Promise((resolve) => {
    execFile(bin, args, opts, (err, stdout) => {
      const out = String(stdout || '').trim();
      if (!err) { resolve({ verdict: 'ok', value: out || null }); return; }
      if (err.code === 'ENOENT') { /* warn */ }
      else if (err.killed) { /* warn */ }
      else if (Number(err.code) === 1) { /* silent */ }
      else if (out) { resolve({ verdict: 'code=' + err.code + '+out', value: out }); return; }
      else { /* warn */ }
      resolve({ verdict: 'null' + (err.code !== undefined ? '(code=' + err.code + ')' : ''), value: null });
    });
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'rtkfake2-'));

function fake(name, exitCode, stdout, stderr) {
  const p = path.join(dir, name + '.mjs');
  writeFileSync(
    p,
    `process.stdout.write(${JSON.stringify(stdout)});\n` +
      `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});\n` +
      `process.exit(${exitCode});\n`,
  );
  return p;
}

const SCEN = [
  ['exit0 + stdout', 0, 'rtk git status', ''],
  ['exit1 + stdout（契约外：应静默透传）', 1, 'rtk git status', ''],
  ['exit2 + 无输出（rtk deny，契约内）', 2, '', ''],
  ['exit2 + 带 stdout（未来 rtk 打印 deny 原因）', 2, 'BLOCKED: rm -rf denied by rule', ''],
  ['exit4 + 带 stdout（未知新码）', 4, 'rtk git status', ''],
  ['exit3 + stdout（契约内）', 3, 'rtk git status', ''],
  ['exit3 + stderr 警告 + stdout', 3, 'rtk git status', 'warning: something'],
];

console.log('# 场景 | 判定 | 返回值 | 会被替换执行？');
for (const [label, code, out, errText] of SCEN) {
  const script = fake('f' + code + '_' + label.length, code, out, errText);
  const r = await judge(process.execPath, [script], { timeout: 5000, windowsHide: true });
  const replaced = !!r.value && r.value !== 'git status';
  console.log(
    label.padEnd(42) + ' | ' + r.verdict.padEnd(20) + ' | ' + JSON.stringify(r.value).slice(0, 46).padEnd(48) + ' | ' + replaced,
  );
}

// maxBuffer 截断（默认 1MB）路径
console.log('\n# maxBuffer 截断路径');
const bigOut = 'rtk ' + 'x'.repeat(2 * 1024 * 1024);
const bigScript = fake('big', 0, bigOut, '');
const rBig = await judge(process.execPath, [bigScript], { timeout: 10000, windowsHide: true });
console.log(
  'exit0 + 2MB stdout -> verdict=' + rBig.verdict +
    ' 长度=' + (rBig.value === null ? 'null' : rBig.value.length) +
    ' 完整?=' + (rBig.value === bigOut) +
    ' 会被替换?=' + (!!rBig.value && rBig.value !== 'git status'),
);
