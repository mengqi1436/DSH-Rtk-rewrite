// 审查实验 20：重定向 / 2>&1 / 多段判定盲区 + `--` 修法在 help 文本场景下的最终确认。
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function rw(args) {
  return new Promise((resolve) => {
    execFile('rtk', args, { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '') });
    });
  });
}

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev20-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor { async execute(s){ globalThis.__last = s.command; return {}; } }
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

console.log('## 1. 重定向命令的 guard 判定 vs 实际情况');
const REDIR = ['ls 2>&1', 'rtk git status 2>&1', 'git status > out.txt', 'git status 2>/dev/null', 'ls |& cat'];
for (const c of REDIR) {
  const guard = mod.isRtkInvocation(c);
  const a = await rw(['rewrite', c]);
  globalThis.__last = undefined;
  await ex.execute({ command: c });
  console.log(
    '  ' + JSON.stringify(c).padEnd(28) +
      ' guard=' + String(guard).padEnd(5) +
      ' rtk(code=' + a.code + ')=' + JSON.stringify(a.out).slice(0, 30).padEnd(32) +
      ' 最终=' + JSON.stringify(String(globalThis.__last ?? '')).slice(0, 34),
  );
}

console.log('\n## 2. `--` 修法在 help 文本场景下（用真实 index.js 逻辑 + 手工加 --）');
const HELP_ARGS = ['-h', '--help'];
for (const c of HELP_ARGS) {
  const without = await rw(['rewrite', c]);
  const withDash = await rw(['rewrite', '--', c]);
  console.log(
    '  ' + JSON.stringify(c).padEnd(10) +
      ' 无--: code=' + without.code + ' len=' + without.out.length + ' helpText=' + /Usage:|Exit codes/.test(without.out) +
      ' | 有--: code=' + withDash.code + ' len=' + withDash.out.length + ' helpText=' + /Usage:|Exit codes/.test(withDash.out),
  );
}

console.log('\n## 3. `--skip-env` 是否也应该被 -- 隔离（避免成为隐藏 flag 面）');
for (const c of ['--skip-env', '--skip-env=1', '--skip-env git status']) {
  const a = await rw(['rewrite', c]);
  const b = await rw(['rewrite', '--', c]);
  console.log('  ' + JSON.stringify(c).padEnd(24) + ' 无--: code=' + a.code + ' out=' + JSON.stringify(a.out).slice(0, 28) + ' | 有--: code=' + b.code + ' out=' + JSON.stringify(b.out).slice(0, 28));
}

rmSync(TMP, { recursive: true, force: true });
