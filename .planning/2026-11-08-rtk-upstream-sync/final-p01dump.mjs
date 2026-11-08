// 终审实验 9（严谨取证）：直接 dump 变异文件的实际 execute() 源码 + 打印加载后的函数体，
// 排除「文件写错」与「模块缓存」两种可能。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const work = mkdtempSync(path.join(tmpdir(), 'p01dump-'));
const origCwd = process.cwd();

const lines = readFileSync(path.join(REPO, 'index.js'), 'utf8').split('\n');
const bs = lines.findIndex((l, i) => i > 200 && l.trim() === 'let rewritten = null;');
const be = lines.findIndex((l, i) => i > bs && l.trim() === 'return super.execute(spec);');
console.log('bs(0-based)=' + bs + ' → 第 ' + (bs + 1) + ' 行: ' + JSON.stringify(lines[bs]));
console.log('be(0-based)=' + be + ' → 第 ' + (be + 1) + ' 行: ' + JSON.stringify(lines[be]));

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
const mutantLines = [...lines.slice(0, bs), ...P01, ...lines.slice(be + 1)];
const mutantSrc = mutantLines.join('\n');
const mutantPath = path.join(work, 'index-mutant.js');
writeFileSync(mutantPath, mutantSrc);

// 从磁盘读回来验证（不是从内存变量）
const fromDisk = readFileSync(mutantPath, 'utf8').split('\n');
const es = fromDisk.findIndex((l) => l.includes('async execute(spec)'));
console.log('\n## 磁盘上变异文件的 execute()（第 ' + (es + 1) + ' 行起）');
for (let i = es; i < es + 26 && i < fromDisk.length; i++) console.log(String(i + 1).padStart(4) + ' | ' + fromDisk[i]);

// 关键断言：super.execute({ ...spec, command: rewritten }) 是否在 try 块内（缩进 8 空格 = 在 try 内）
const tryLine = fromDisk.findIndex((l, i) => i > es && l.trim() === 'try {');
const catchLine = fromDisk.findIndex((l, i) => i > tryLine && l.trim().startsWith('} catch'));
console.log('\n## try 块行范围: ' + (tryLine + 1) + ' .. ' + (catchLine + 1));
console.log('  try 内是否含改写版 super.execute：' +
  fromDisk.slice(tryLine, catchLine).some((l) => l.includes('super.execute({ ...spec, command: rewritten })')));

// 现在用假 dsh 加载这个文件，打印加载后的 execute.toString() 看真实逻辑
const FAKE_DSH = path.join(work, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
const FAKE_BIN = path.join(work, 'bin');
mkdirSync(FAKE_BIN, { recursive: true });
writeFileSync(path.join(FAKE_BIN, 'rewrite'), `'use strict';
const a = process.argv.slice(2);
const iso = a[0] === '--';
const cmd = iso ? (a[1] ?? '') : (a[0] ?? '');
process.stdout.write('rtk ' + cmd);
process.exit(3);
`);
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh-install', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxUnavailableError extends Error { constructor(d){ super('SANDBOX_UNAVAILABLE: '+d); this.name='SandboxUnavailableError'; } }
class SandboxPwshExecutor {
  constructor(o){ this.opts=o; }
  resolve(s){ return { ...s }; }
  async execute(spec){
    globalThis.__specs = globalThis.__specs || [];
    globalThis.__specs.push(String(spec.command));
    const isRw = String(spec.command).startsWith('rtk ');
    if (globalThis.__MODE === 'sandbox' && isRw) throw new SandboxUnavailableError('runner broken');
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor, SandboxUnavailableError };
`);

process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = process.execPath;
process.chdir(FAKE_BIN);

async function loadAndProbe(label, file, mode) {
  globalThis.__specs = [];
  globalThis.__MODE = mode;
  const mod = await import(pathToFileURL(file).href + '?v=' + Math.random().toString(36).slice(2));
  const ex = new mod.default({});
  let thrown = null;
  try { await ex.execute({ command: 'git status' }); } catch (e) { thrown = e; }
  console.log(`  ${label.padEnd(16)} mode=${String(mode||'none').padEnd(8)} specs=${globalThis.__specs.length} ${JSON.stringify(globalThis.__specs).padEnd(42)} thrown=${thrown ? thrown.name : 'none'}`);
  if (label === '变异版' && mode === null) {
    console.log('\n## 加载后 execute.toString() 片段（变异版）');
    const s = ex.execute.toString();
    console.log(s.split('\n').slice(0, 24).map((l) => '  ' + l).join('\n'));
  }
  return { specs: globalThis.__specs, thrown };
}

console.log('\n## 运行时行为对比');
await loadAndProbe('原版', path.join(REPO, 'index.js'), 'sandbox');
await loadAndProbe('原版', path.join(REPO, 'index.js'), null);
const m1 = await loadAndProbe('变异版', mutantPath, 'sandbox');
const m2 = await loadAndProbe('变异版', mutantPath, null);

console.log('\n## 结论');
console.log('  变异版 + sandbox: specs=' + m1.specs.length + '（应为 2）+ thrown=' + (m1.thrown ? m1.thrown.name : 'none') + '（应为 none）');

process.chdir(origCwd);
rmSync(work, { recursive: true, force: true });
