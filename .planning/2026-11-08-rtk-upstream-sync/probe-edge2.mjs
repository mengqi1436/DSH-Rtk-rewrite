// 审查实验 10：改造后 index.js 的边界行为 + 被 guard 漏掉的形态在真 rtk 下的后果。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev10-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  async execute(spec) {
    globalThis.__specs = globalThis.__specs || [];
    globalThis.__specs.push({ command: spec.command, keyCount: Object.keys(spec).length, keys: Object.keys(spec) });
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

function realRewrite(cmd) {
  return new Promise((resolve) => {
    execFile('rtk', ['rewrite', cmd], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '') });
    });
  });
}

console.log('## A. 被 guard 漏掉的形态在真 rtk 下的实际后果（guard=false 才会问 rtk）');
const MISSED = [
  'FOO="a b" rtk git status',
  'powershell -c "rtk git status"',
  'sudo rtk git status',
  'rtk=1 ls',
  "rtk' git status",
];
for (const c of MISSED) {
  const guard = mod.isRtkInvocation(c);
  const r = await realRewrite(c);
  globalThis.__specs = [];
  let thrown = null;
  try { await ex.execute({ command: c }); } catch (e) { thrown = e; }
  const execd = globalThis.__specs.at(-1)?.command;
  console.log(
    '  guard=' + String(guard).padEnd(5) +
      ' rtk(code=' + r.code + ')=' + JSON.stringify(r.out).slice(0, 40).padEnd(42) +
      ' | 最终执行=' + JSON.stringify(execd).slice(0, 40) +
      (thrown ? ' THROWN=' + thrown.message.slice(0, 40) : ''),
  );
}

console.log('\n## B. 非字符串 / 极端 command');
for (const [label, cmd] of [
  ['undefined', undefined],
  ['null', null],
  ['number', 42],
  ['object', { a: 1 }],
  ['空串', ''],
  ['空白串', '   '],
  ['含 NUL', 'git status\u0000--x'],
  ['超长 200KB', 'x'.repeat(200000)],
]) {
  globalThis.__specs = [];
  let thrown = null;
  try { await ex.execute({ command: cmd }); } catch (e) { thrown = e; }
  const s = globalThis.__specs;
  console.log(
    '  ' + label.padEnd(14) +
      ' specs=' + s.length +
      ' executed=' + JSON.stringify(s.at(-1)?.command).slice(0, 40) +
      (thrown ? ' THROWN=' + thrown.constructor.name + ': ' + String(thrown.message).slice(0, 50) : ''),
  );
}

console.log('\n## C. spec 字段保真（关键字段逐个核对）');
const spec = {
  command: 'git status', workdir: 'D:\\w', timeoutMs: 1234, onExpiry: 'kill', stdoutMaxBytes: 65536,
  signal: new AbortController().signal, stdin: 'x', env: { A: '1' }, dshEnv: { B: '2' },
  sandboxPolicy: { mode: 'workspace-write' },
};
globalThis.__specs = [];
await ex.execute(spec);
const got = globalThis.__specs.at(-1);
console.log('  收到的 key:', JSON.stringify(got.keys));
const missing = Object.keys(spec).filter((k) => !got.keys.includes(k));
console.log('  缺失字段:', JSON.stringify(missing));

// 用 getter / 原型链模拟「spread 会丢的字段」
console.log('\n## D. spread 对 getter / 原型链字段的行为');
const proto = { inherited: 'from-proto' };
const withGetter = Object.create(proto);
Object.defineProperty(withGetter, 'command', { value: 'git status', enumerable: true, configurable: true });
Object.defineProperty(withGetter, 'hiddenField', { value: 'non-enumerable', enumerable: false, configurable: true });
Object.defineProperty(withGetter, 'lazyField', { get() { return 'computed'; }, enumerable: true, configurable: true });
const spread = { ...withGetter };
console.log('  spread 后 keys:', JSON.stringify(Object.keys(spread)));
console.log('  非枚举 hiddenField 是否保留:', 'hiddenField' in spread);
console.log('  原型 inherited 是否保留:', 'inherited' in spread);
console.log('  >> 结论：spread 只取自有可枚举属性（getter 会被求值成快照）');

rmSync(TMP, { recursive: true, force: true });
