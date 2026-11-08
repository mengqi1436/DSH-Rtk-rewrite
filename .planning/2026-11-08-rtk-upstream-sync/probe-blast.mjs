// 审查实验 22（关键精化）：按上游真实契约建模 —— execute() 何时 reject，何时只有 result() reject。
// 目的：把 P0-1 的爆炸半径量化，不夸大。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev22-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));

// 严格模仿上游 SandboxPwshExecutor 的两级契约：
//  A) execute() 自身 reject  —— 取消（pwsh-local:285 throwIfAborted）、confine 失败（:289 throw）
//  B) execute() 正常返回 handle，错误只在 result() 里 reject —— SandboxUnavailableError（:129）、mapError（:134-137）
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  async execute(spec) {
    globalThis.__calls = globalThis.__calls || [];
    globalThis.__calls.push(String(spec.command));
    const mode = globalThis.__FAIL_MODE;

    // A) execute() 阶段就 reject 的两条真实路径
    if (mode === 'pre-abort' && spec.signal && spec.signal.aborted) {
      const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e;
    }
    if (mode === 'confine-fail') {
      const e = new Error('SandboxUnavailableError: runner chain broken'); e.name = 'SandboxUnavailableError'; throw e;
    }

    // B) execute() 成功返回 handle；错误延后到 result()
    const result = async () => {
      if (mode === 'result-fail') {
        const e = new Error('SandboxUnavailableError: denial runner failed'); e.name = 'SandboxUnavailableError'; throw e;
      }
      return { executed: spec.command, exitCode: 0 };
    };
    return { status: 'completed', result, done: Promise.resolve() };
  }
}
module.exports = { SandboxPwshExecutor };
`);

process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

async function trial(label, mode, spec) {
  globalThis.__calls = [];
  globalThis.__FAIL_MODE = mode;
  let execThrown = null;
  let handle = null;
  try { handle = await ex.execute(spec); } catch (e) { execThrown = e; }
  let resultThrown = null;
  if (handle && typeof handle.result === 'function') {
    try { await handle.result(); } catch (e) { resultThrown = e; }
  }
  console.log(
    '  ' + label.padEnd(30) +
      ' execute阶段=' + (execThrown ? 'REJECT(' + execThrown.name + ')' : 'ok').padEnd(28) +
      ' result阶段=' + (resultThrown ? 'REJECT(' + resultThrown.name + ')' : 'ok').padEnd(32) +
      ' 调用序列=' + JSON.stringify(globalThis.__calls),
  );
}

const ac = new AbortController();
ac.abort(new Error('user cancelled'));

console.log('## A) execute() 自身 reject 的两条真实路径');
await trial('前置取消（signal 已 abort）', 'pre-abort', { command: 'git status', signal: ac.signal });
await trial('confine 失败', 'confine-fail', { command: 'git status' });
await trial('对照：正常，取消但无失败', null, { command: 'git status', signal: ac.signal });

console.log('\n## B) execute() 成功、错误只在 result() 里（上游主路径）');
await trial('result 投影时沙箱失败', 'result-fail', { command: 'git status' });

console.log('\n## C) guard 命中（命令本身是 rtk，不走 try）');
await trial('命令本身是 rtk + confine 失败', 'confine-fail', { command: 'rtk git status' });

console.log('\n## 结论：');
console.log('  A 类（execute reject）→ 插件 catch 吞掉 → 原命令再执行一次（双执行成立）');
console.log('  B 类（result reject）→ 插件已 return handle，catch 未覆盖 → 错误正常上抛（双执行不成立）');

rmSync(TMP, { recursive: true, force: true });
