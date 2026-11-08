// 审查实验 6：变异测试 —— 证明现有 test.js 无法捕获 index.js 的行为回归。
// 做法：把 index.js 复制到临时目录，注入变异体，跑 test.js 看是否变红。
// 不修改仓库正文文件。
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(repo, 'index.js'), 'utf8');
const testSrc = readFileSync(path.join(repo, 'test.js'), 'utf8');
const pkg = readFileSync(path.join(repo, 'package.json'), 'utf8');

const MUTANTS = [
  {
    name: 'M1 删掉 exit-1 静默分支（把 1 当成有输出）',
    from: "} else if (Number(err.code) === 1) {\n          // rtk's documented \"no equivalent\" exit: silent pass-through.\n        } else if (out) {",
    to: "} else if (Number(err.code) === 1) {\n          resolve(out || 'MUTATED');\n          return;\n        } else if (out) {",
  },
  {
    name: 'M2 反转幂等检查（rewritten !== command -> 恒真）',
    from: 'if (rewritten && rewritten !== spec.command) {',
    to: 'if (rewritten) {',
  },
  {
    name: 'M3 递归防护全删（guard 永假）',
    from: "if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) {",
    to: 'if (false) {',
  },
  {
    name: 'M4 失败时阻断（不再 fail-open，改为抛错）',
    from: '    return super.execute(spec);\n  }\n}',
    to: "    throw new Error('MUTATED: blocked instead of fail-open');\n  }\n}",
  },
  {
    name: 'M5 超时不再兜底（killed 分支改为直接返回改写结果）',
    from: '} else if (err.killed) {\n          warn(`rewrite timed out after ${REWRITE_TIMEOUT_MS}ms; running command unrewritten`);',
    to: "} else if (err.killed) {\n          resolve(out || 'MUTATED-TIMEOUT');\n          return;",
  },
  {
    name: 'M6 spec spread 丢字段（只传 command）',
    from: 'return await super.execute({ ...spec, command: rewritten });',
    to: 'return await super.execute({ command: rewritten });',
  },
];

const workDir = mkdtempSync(path.join(tmpdir(), 'rtkmut-'));
const results = [];

for (const m of MUTANTS) {
  const dir = path.join(workDir, m.name.split(' ')[0]);
  if (!existsSync(dir)) execFileSync('mkdir', ['-p', dir]);
  if (!src.includes(m.from)) {
    results.push(`${m.name}: SKIP（变异点未在源码中出现，可能已被改造）`);
    continue;
  }
  const mutated = src.replace(m.from, m.to);
  writeFileSync(path.join(dir, 'index.js'), mutated);
  writeFileSync(path.join(dir, 'test.js'), testSrc);
  writeFileSync(path.join(dir, 'package.json'), pkg);
  try {
    execFileSync('node', ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
    results.push(`${m.name}: 仍全绿  << 未被捕获（测试无效）`);
  } catch (e) {
    results.push(`${m.name}: 变红 ✓ 被捕获（${String(e.stdout || '').split('\n').filter((l) => l.includes('FAIL')).join(' ') || 'exit!=0'}）`);
  }
}

console.log(results.join('\n'));
console.log('\n工作目录：' + workDir);
