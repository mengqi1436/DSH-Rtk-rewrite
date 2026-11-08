// 终审实验 8（决定性取证）：为什么 E0 组对 P0-1 变异体无感？
// 直接复刻 test.js 的假 dsh + 假 rtk 环境，手动设 __FAIL_MODE，观察 specs 长度。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const work = mkdtempSync(path.join(tmpdir(), 'p01probe-'));
const FAKE_DSH = path.join(work, 'dsh');
const FAKE_BIN = path.join(work, 'bin');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
mkdirSync(FAKE_BIN, { recursive: true });

// 假 rtk —— 与 test.js 一致（含 P1-1 的 clap 复刻）
writeFileSync(path.join(FAKE_BIN, 'rewrite'), `'use strict';
const scriptArgs = process.argv.slice(2);
const isolated = scriptArgs[0] === '--';
const cmd = isolated ? (scriptArgs[1] ?? '') : (scriptArgs[0] ?? '');
if (cmd.startsWith('-')) {
  if (!isolated) { process.stdout.write('Rewrite a raw command' + String.fromCharCode(10) + 'Usage: x'); process.exit(0); }
  process.exit(1);
}
process.stdout.write('rtk ' + cmd);
process.exit(3);
`);

// 假 dsh —— 与 test.js:119-150 逐字一致
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh-install', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxUnavailableError extends Error {
  constructor(detail) { super('SANDBOX_UNAVAILABLE: ' + detail); this.name = 'SandboxUnavailableError'; }
}
class SandboxPwshExecutor {
  constructor(opts) { this.opts = opts; }
  resolve(spec) { return { ...spec, sandboxResolved: true }; }
  async execute(spec) {
    globalThis.__rtkSpecs = globalThis.__rtkSpecs || [];
    globalThis.__rtkSpecs.push(spec);
    const mode = globalThis.__FAIL_MODE;
    const isRewritten = String(spec.command).startsWith('rtk ');
    if (mode === 'abort-always' && isRewritten) { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; }
    if (mode === 'abort-check' && spec.signal && spec.signal.aborted === true) { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; }
    if (mode === 'sandbox' && isRewritten) { throw new SandboxUnavailableError('runner chain broken'); }
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor, SandboxUnavailableError };
`);

process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = process.execPath;
process.chdir(FAKE_BIN);

// ── 构造 P0-1 变异版 index.js（按行号精确替换）──
const lines = readFileSync(path.join(REPO, 'index.js'), 'utf8').split('\n');
const bs = lines.findIndex((l, i) => i > 200 && l.trim() === 'let rewritten = null;');
const be = lines.findIndex((l, i) => i > bs && l.trim() === 'return super.execute(spec);');
const P01 = [
  '    let rewritten = null;',
  '    try {',
  '      rewritten = await rtkRewrite(spec.command);',
  '      if (rewritten && rewritten !== spec.command) {',
  "        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));",
  '        return super.execute({ ...spec, command: rewritten });',
  '      }',
  '    } catch (err) {',
  '      warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);',
  '    }',
  '    return super.execute(spec);',
];
const mutantPath = path.join(work, 'index-mutant.js');
writeFileSync(mutantPath, [...lines.slice(0, bs), ...P01, ...lines.slice(be + 1)].join('\n'));

async function probe(label, modPath, failMode) {
  globalThis.__rtkSpecs = [];
  globalThis.__FAIL_MODE = failMode || undefined;
  const mod = await import(pathToFileURL(modPath).href + '?t=' + Date.now() + Math.random());
  const ex = new mod.default({});
  let thrown = null;
  try { await ex.execute({ command: 'git status' }); } catch (e) { thrown = e; }
  const cmds = (globalThis.__rtkSpecs || []).map((s) => s.command);
  console.log(
    '  ' + label.padEnd(28) +
      ' mode=' + String(failMode || 'none').padEnd(14) +
      ' specs=' + cmds.length + ' ' + JSON.stringify(cmds).padEnd(46) +
      ' thrown=' + (thrown ? thrown.name : 'none'),
  );
  return { specs: cmds, thrown };
}

console.log('## 原始 index.js');
await probe('原版', path.join(REPO, 'index.js'), 'sandbox');
await probe('原版', path.join(REPO, 'index.js'), null);

console.log('\n## P0-1 变异版 index.js');
await probe('变异版', mutantPath, 'sandbox');
await probe('变异版', mutantPath, null);

console.log('\n## 判据');
console.log('  变异版 + mode=sandbox 若 specs=2 且 thrown=none → P0-1 缺陷已复现，E0 组理应捕获。');
console.log('  变异版 + mode=sandbox 若 specs=1 → 变异未真正生效。');

rmSync(work, { recursive: true, force: true });
