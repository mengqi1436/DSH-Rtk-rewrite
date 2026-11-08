// 审查实验 6b：变异测试的对照组 —— 证明上面 probe-mutation 的「全变红」是假红，
// 真实原因是临时目录缺 node_modules 导致 index.js 加载失败，而不是断言捕获了变异。
import { readFileSync, writeFileSync, mkdtempSync, existsSync, symlinkSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(repo, 'index.js'), 'utf8');
const testSrc = readFileSync(path.join(repo, 'test.js'), 'utf8');
const pkg = readFileSync(path.join(repo, 'package.json'), 'utf8');

function runCase(dir, label) {
  try {
    const stdout = execFileSync('node', ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return { label, status: 'GREEN', tail: stdout.split('\n').slice(-3).join(' | ') };
  } catch (e) {
    const all = (String(e.stdout || '') + '\n' + String(e.stderr || '')).split('\n');
    const failLines = all.filter((l) => /FAIL|Error:|Cannot resolve|ENOENT/.test(l)).slice(0, 2);
    return { label, status: 'RED', tail: failLines.join(' | ').slice(0, 200) };
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'rtkmut2-'));

// 对照组 A：完全未变异的 index.js，但缺 node_modules
const a = path.join(work, 'control-no-modules');
execFileSync('mkdir', ['-p', a]);
writeFileSync(path.join(a, 'index.js'), src);
writeFileSync(path.join(a, 'test.js'), testSrc);
writeFileSync(path.join(a, 'package.json'), pkg);
console.log('对照组 A（未变异、缺 node_modules）：', JSON.stringify(runCase(a, 'control-no-modules')));

// 对照组 B：完全未变异 + 有 node_modules（符号链接仓库的 node_modules）
const b = path.join(work, 'control-with-modules');
execFileSync('mkdir', ['-p', b]);
writeFileSync(path.join(b, 'index.js'), src);
writeFileSync(path.join(b, 'test.js'), testSrc);
writeFileSync(path.join(b, 'package.json'), pkg);
try {
  symlinkSync(path.join(repo, 'node_modules'), path.join(b, 'node_modules'), 'junction');
} catch (e) {
  console.log('  junction 失败:', e.code);
}
console.log('对照组 B（未变异、有 node_modules）：', JSON.stringify(runCase(b, 'control-with-modules')));

// 变异体 M2（幂等检查恒真）+ 有 node_modules —— 真正检验断言能否捕获
const MUT = {
  M2: { from: 'if (rewritten && rewritten !== spec.command) {', to: 'if (rewritten) {' },
  M3: { from: "if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) {", to: 'if (false) {' },
  M4: { from: '    return super.execute(spec);\n  }\n}', to: "    throw new Error('MUTATED');\n  }\n}" },
  M6: { from: 'return await super.execute({ ...spec, command: rewritten });', to: 'return await super.execute({ command: rewritten });' },
};
for (const [name, m] of Object.entries(MUT)) {
  const dir = path.join(work, 'mut-' + name);
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(path.join(dir, 'index.js'), src.includes(m.from) ? src.replace(m.from, m.to) : src);
  writeFileSync(path.join(dir, 'test.js'), testSrc);
  writeFileSync(path.join(dir, 'package.json'), pkg);
  try { symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  console.log(`变异体 ${name}（有 node_modules）：`, JSON.stringify(runCase(dir, name)));
}

console.log('\n工作目录：' + work);
