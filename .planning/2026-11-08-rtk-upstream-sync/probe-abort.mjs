// 审查实验 19：验证 catch 过宽吞掉取消（AbortError）与沙箱异常后的重执行。
// 这是 P0 判定的决定性证据。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev19-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));

// 假 SandboxPwshExecutor：模拟三种真实上游失败
//  a) 改写版（rtk 前缀）因取消抛 AbortError
//  b) 改写版因沙箱 runner 失败抛 SandboxUnavailableError
//  c) 记录每次 execute，验证原命令是否被第二次执行
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  async execute(spec) {
    globalThis.__calls = globalThis.__calls || [];
    globalThis.__calls.push(String(spec.command));
    const mode = globalThis.__FAIL_MODE;
    const isRewritten = String(spec.command).startsWith('rtk ');
    if (mode === 'abort' && isRewritten && spec.signal && spec.signal.aborted) {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (mode === 'abort-always' && isRewritten) {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (mode === 'sandbox' && isRewritten) {
      const e = new Error('SANDBOX_UNAVAILABLE: runner chain broken');
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
const ex = new mod.default({});

async function trial(label, spec, failMode) {
  globalThis.__calls = [];
  globalThis.__FAIL_MODE = failMode;
  let thrown = null;
  try { await ex.execute(spec); } catch (e) { thrown = e; }
  console.log(
    '  ' + label.padEnd(36) +
      ' 调用序列=' + JSON.stringify(globalThis.__calls).padEnd(50) +
      ' 抛出=' + (thrown ? thrown.name : 'none'),
  );
}

console.log('## 1. 取消（signal.aborted）场景');
const ac = new AbortController();
ac.abort(new Error('user cancelled'));
await trial('已取消 + abort-always', { command: 'git status', signal: ac.signal }, 'abort-always');
await trial('已取消 + 正常', { command: 'git status', signal: ac.signal }, null);

console.log('\n## 2. 沙箱 unavailable 场景');
await trial('沙箱 runner 失败', { command: 'git status' }, 'sandbox');

console.log('\n## 3. 对照：guard 命中（rtk 调用）不走 catch');
await trial('命令本身是 rtk', { command: 'rtk git status' }, 'sandbox');

console.log('\n## 4. 双执行对写操作的实际含义');
console.log('  若改写版已 spawn 进程（如 `rtk git push` = git push）后 super.execute 在 settle 阶段抛错，');
console.log('  catch 会让原命令 `git push` 再跑一次 —— 同一写操作执行两遍。');

// 验证上游 execute() 何时抛（读源码结论复核）
console.log('\n## 5. 上游 SandboxPwshExecutor.execute 的抛异常位置（源码复核）');
const f = 'D:\\Code\\_upstream\\dsh\\packages\\shell\\pwsh-sandbox\\src\\index.ts';
const src = (await import('node:fs')).readFileSync(f, 'utf8');
const marks = [
  ['execute() 入口', 'override async execute(spec: ShellExecSpec)'],
  ['sandbox unavailable 抛出（result 投影）', 'throw new SandboxUnavailableError(mode, runnerFailure.detail)'],
  ['取消抛出（execute 内）', 'if (spec.signal?.aborted === true) spec.signal.throwIfAborted()'],
  ['runner spawn 失败抛出', 'if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir))'],
];
for (const [name, needle] of marks) {
  const i = src.indexOf(needle);
  const line = i === -1 ? 'NOT FOUND' : src.slice(0, i).split('\n').length;
  console.log('  ' + name.padEnd(40) + ' line ' + line);
}

rmSync(TMP, { recursive: true, force: true });
