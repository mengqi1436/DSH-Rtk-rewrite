import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve('.');
const SRC = path.join(ROOT, 'index.js');
const DIR = path.join(ROOT, '.planning/2026-11-20-rtk-parity/mutants');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const src = readFileSync(SRC, 'utf8');

/** 变异体：name -> { old, neo, expect: 'red'|'green-expected' , why } */
const MUTANTS = [
  {
    name: 'm1_flat_prefix_guard',
    why: '把分段感知的 isRtkInvocation 退回单串 startsWith("rtk ")（旧实现）',
    old: `export function isRtkInvocation(command) {
  const segments = splitSegments(String(command));
  return segments.length > 0 && segments.every(isRtkSegment);
}`,
    neo: `export function isRtkInvocation(command) {
  return String(command).trimStart().startsWith('rtk ');
}`,
  },
  {
    name: 'm2_drop_exit3',
    why: '删掉 exit 3 采纳分支（只认 exit 0，即「误读 help 文本」的经典错误）',
    old: `        } else if (Number(err.code) === 3 && out) {
          // 3 = rewritten, approval deferred to the host. The normal case.
          resolve(out);
          return;`,
    neo: `        } else if (Number(err.code) === 3 && out) {
          // MUTANT: 丢弃 exit 3 的改写结果`,
  },
  {
    name: 'm3_accept_identity',
    why: '去掉恒等抑制（rewritten !== spec.command）',
    old: `    if (rewritten && rewritten !== spec.command) {`,
    neo: `    if (rewritten) {`,
  },
  {
    name: 'm4_exit2_adopts_stdout',
    why: 'exit 2 也采纳 stdout（把 deny/路由提示当命令执行）—— 检验是否存在裁判它的用例',
    old: `        } else if (Number(err.code) === 2) {
          // Deny rule matched. Anything on stdout is a pipeline-rule message,
          // never a command line, so it must not be handed to the shell.`,
    neo: `        } else if (Number(err.code) === 2 && out) {
          // MUTANT: 把 exit 2 的 stdout 当命令采纳
          resolve(out);
          return;`,
  },
  {
    name: 'm5_skip_env_prefix_strip',
    why: '去掉 ENV 前缀跳过（FOO=1 rtk ... 不再判为 rtk 调用）',
    old: `    if (!ENV_ASSIGNMENT.test(word)) break;`,
    neo: `    break;`,
  },
];

const results = [];
for (const m of MUTANTS) {
  if (!src.includes(m.old)) {
    results.push({ name: m.name, status: 'MUTANT-BUILD-FAILED', detail: '原代码片段未找到' });
    continue;
  }
  const mutated = src.replace(m.old, m.neo);
  const file = path.join(DIR, m.name + '.js');
  writeFileSync(file, mutated);
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, ['test.js'], {
      encoding: 'utf8',
      env: { ...process.env, RTK_TEST_TARGET: path.relative(ROOT, file).replaceAll('\\\\', '/'), RTK_TEST_FAST: '1' },
      timeout: 300000,
    });
    code = 0;
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
    code = e.status ?? -1;
  }
  const tail = out.split('\n').filter((l) => /总共|RESULT|失败项|FAIL /.test(l)).join(' | ');
  const total = (out.match(/总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/) || []);
  results.push({
    name: m.name, why: m.why, exitCode: code,
    total: total[1], passed: total[2], failed: total[3],
    verdict: code !== 0 ? 'RED(捕获)' : 'GREEN(存活)',
    failedNames: out.split('\n').filter((l) => /^  · \[/.test(l)).slice(0, 8),
  });
}
console.log(JSON.stringify(results, null, 2));
