// 审查实验 18：幂等链（guard 漏判形态是否收敛）+ `-h`/`--help` 触发面的精确边界。
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function rw(cmd) {
  return new Promise((resolve) => {
    execFile('rtk', ['rewrite', cmd], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '') });
    });
  });
}

console.log('## 幂等链：连续 rewrite 到稳定（限 6 轮）');
const SEEDS = ['rtk\r\ngit status', 'rtk git status\r\nls', 'rtk git status # ; ls', 'rtk git status `; ls', 'rtk  git status', 'ls; rtk git status'];
for (const seed of SEEDS) {
  let cur = seed;
  const chain = [cur];
  for (let i = 0; i < 6; i++) {
    const r = await rw(cur);
    const next = r.out.trim();
    if (!next || next === cur) break;
    cur = next;
    chain.push(cur);
  }
  console.log('  seed=' + JSON.stringify(seed));
  for (const [i, c] of chain.entries()) console.log('    [' + i + '] ' + JSON.stringify(c));
}

console.log('\n## `-h` / `--help` 触发面边界（首词位置）');
const BOUND = ['-h', '--help', '-H', '--HELP', '-help', '--h', '-hh', '--help ', ' --help', '\t--help', '--help;', '"--help"'];
for (const c of BOUND) {
  const r = await rw(c);
  const isHelp = /Usage:|Exit codes/.test(r.out);
  console.log('  ' + JSON.stringify(c).padEnd(12) + ' code=' + String(r.code).padEnd(4) + ' helpText=' + isHelp + ' len=' + r.out.length);
}

// 真实 index.js 在此边界下的行为
const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev18-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor { async execute(s){ globalThis.__last = s.command; return { executed: s.command }; } }
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

console.log('\n## 改造后 index.js 在 `-h` 边界的最终执行内容');
for (const c of ['-h', '--help', '-H', ' --help', '--help;']) {
  globalThis.__last = undefined;
  await ex.execute({ command: c });
  const v = String(globalThis.__last ?? '');
  console.log('  ' + JSON.stringify(c).padEnd(12) + ' 最终执行长度=' + v.length + ' 前60字符=' + JSON.stringify(v.slice(0, 60)));
}

rmSync(TMP, { recursive: true, force: true });
