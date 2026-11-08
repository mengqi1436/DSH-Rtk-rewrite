// 审查实验 10b：非字符串 command 的真实后果（修正 JSON.stringify(undefined) 无返回值的问题）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev10b-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  async execute(spec) {
    globalThis.__specs = globalThis.__specs || [];
    globalThis.__specs.push({ command: spec.command, keys: Object.keys(spec) });
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

const show = (v) => {
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch { return String(v); }
};

console.log('## B. 非字符串 / 极端 command（改造后 index.js）');
const CASES = [
  ['undefined', undefined],
  ['null', null],
  ['number 42', 42],
  ['object', { a: 1 }],
  ['空串', ''],
  ['空白串', '   '],
  ['含 NUL', 'git status\u0000--x'],
  ['含 CRLF', 'git status\r\ngit diff'],
  ['200KB', 'x'.repeat(200000)],
];
for (const [label, cmd] of CASES) {
  globalThis.__specs = [];
  let thrown = null;
  try { await ex.execute({ command: cmd }); } catch (e) { thrown = e; }
  const s = globalThis.__specs;
  console.log(
    '  ' + label.padEnd(12) +
      ' super.execute 次数=' + s.length +
      ' 最终执行=' + show(s.at(-1)?.command).slice(0, 44) +
      (thrown ? '  THROWN=' + thrown.constructor.name + ': ' + String(thrown.message).slice(0, 56) : ''),
  );
}

console.log('\n## C. spec 字段保真（改造后 index.js 实际透传的 key）');
const ac = new AbortController();
const spec = {
  command: 'git status', workdir: 'D:\\w', timeoutMs: 1234, onExpiry: 'kill', stdoutMaxBytes: 65536,
  signal: ac.signal, stdin: 'x', env: { A: '1' }, dshEnv: { B: '2' },
  sandboxPolicy: { mode: 'workspace-write' },
};
globalThis.__specs = [];
await ex.execute(spec);
const got = globalThis.__specs.at(-1);
console.log('  收到 keys:', show(got.keys));
console.log('  缺失字段:', show(Object.keys(spec).filter((k) => !got.keys.includes(k))));

console.log('\n## D. 非枚举 / 原型链字段在 spread 下的行为（理论验证）');
const proto = { inherited: 'from-proto' };
const withGetter = Object.create(proto);
Object.defineProperty(withGetter, 'command', { value: 'git status', enumerable: true, configurable: true });
Object.defineProperty(withGetter, 'hiddenField', { value: 'non-enumerable', enumerable: false, configurable: true });
Object.defineProperty(withGetter, 'lazyField', { get() { return 'computed'; }, enumerable: true, configurable: true });
const spread = { ...withGetter };
console.log('  spread 后自有键:', show(Object.keys(spread)));
console.log('  非枚举 hiddenField 保留:', 'hiddenField' in spread);
console.log('  原型 inherited 保留:', 'inherited' in spread);

rmSync(TMP, { recursive: true, force: true });
