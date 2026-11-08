// 审查实验 9：用**改造后的真实 index.js** 测递归防护矩阵 + catch 过宽的双执行。
// 通过 DSH_INSTALL_PACKAGE_JSON 注入假 dsh 包，绕开 node_modules 依赖。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev9-'));
const FAKE_DSH = path.join(TMP, 'dsh');
const FAKE_BIN = path.join(TMP, 'bin');

mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
mkdirSync(FAKE_BIN, { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs',
}));
// 假 SandboxPwshExecutor：记录每次 super.execute，并可注入失败
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  constructor() {}
  resolve(spec) { return { ...spec }; }
  async execute(spec) {
    globalThis.__specs = globalThis.__specs || [];
    globalThis.__specs.push(JSON.parse(JSON.stringify({ command: spec.command })));
    if (globalThis.__FAIL_ON_REWRITTEN && String(spec.command).startsWith('rtk ')) {
      const e = new Error('SANDBOX_UNAVAILABLE: runner failed');
      e.name = 'SandboxUnavailableError';
      throw e;
    }
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor };
`);

process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());

console.log('## 1. isRtkInvocation 矩阵（改造后真实实现）');
const GUARD = [
  'rtk', 'rtk ', 'rtk git status', 'rtk.exe git status', 'rtk  git status',
  'rtk\tgit status', 'rtk\r\ngit status', 'rtk\rgit status',
  'RTK git status', 'RTK.EXE git status', 'RtK git status',
  ' rtk git status', '\trtk git status', '\nrtk git status',
  '"rtk" git status', "'rtk' git status", '"rtk.exe" git status',
  'C:\\Users\\Sjc\\.local\\bin\\rtk.exe git status',
  'C:/Users/Sjc/.local/bin/rtk.exe git status',
  '/c/Users/Sjc/.local/bin/rtk git status',
  './rtk git status', '../bin/rtk.exe status',
  'RTK_DISABLED=1 rtk git status', 'FOO=1 BAR=2 rtk git status',
  'FOO="a b" rtk git status', 'rtk=1 ls',
  'sudo rtk git status', '& rtk git status', 'powershell -c "rtk git status"',
  'rtk git status && rtk git diff', 'rtk git status; rtk gain',
  'rtk git status | rtk grep x', 'ls && rtk git status', 'ls; rtk git status',
  'ls | rtk grep foo', 'false || rtk git status', 'echo x\nrtk git status',
  'rtk2 git status', 'rtk.exe.bak git status', 'myrtk git status',
  'echo rtk', 'git status', 'ls -la',
  '"rtk git status', "rtk' git status",
];
for (const c of GUARD) {
  const r = mod.isRtkInvocation(c);
  console.log('  ' + String(r).padEnd(5) + ' ' + JSON.stringify(c));
}

console.log('\n## 2. catch 过宽：super.execute 抛异常时是否吞掉 + 双执行');
globalThis.__FAIL_ON_REWRITTEN = true;
const ex = new mod.default({});
globalThis.__specs = [];
let thrown = null;
try { await ex.execute({ command: 'git status' }); } catch (e) { thrown = e; }
console.log('  super.execute 调用序列（含 command）:', JSON.stringify(globalThis.__specs));
console.log('  向上抛出:', thrown ? thrown.name + ': ' + thrown.message : 'none');
console.log('  >> 若序列含两条 = 同一逻辑命令被执行两次；若 thrown=none = 沙箱异常被吞');
globalThis.__FAIL_ON_REWRITTEN = false;

console.log('\n## 3. 沙箱异常是否被降级为「原命令」');
globalThis.__FAIL_ON_REWRITTEN = true;
globalThis.__specs = [];
// 原命令本身也会失败（不 startsWith rtk），所以只让改写版失败
let t2 = null;
try { await ex.execute({ command: 'ls -la' }); } catch (e) { t2 = e; }
console.log('  ls -la 场景 specs:', JSON.stringify(globalThis.__specs), 'thrown:', t2 ? t2.message : 'none');
globalThis.__FAIL_ON_REWRITTEN = false;

rmSync(TMP, { recursive: true, force: true });
