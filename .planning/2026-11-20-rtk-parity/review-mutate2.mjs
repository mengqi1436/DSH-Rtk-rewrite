import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve('.');
const SRC = path.join(ROOT, 'index.js');
const DIR = path.join(ROOT, '.planning/2026-11-20-rtk-parity/mutants');
mkdirSync(DIR, { recursive: true });
const src = readFileSync(SRC, 'utf8');

const MUTANTS = [
  {
    name: 'm6_prefix_misjudged_as_rtk',
    why: '模拟「透明前缀被误判为已是 rtk 调用」：任何含 uv run/timeout/time/nice/noglob/command/exec/nocorrect 前缀的 rtk 命令都 skip',
    old: `export function isRtkInvocation(command) {
  const segments = splitSegments(String(command));
  return segments.length > 0 && segments.every(isRtkSegment);
}`,
    neo: `export function isRtkInvocation(command) {
  const c = String(command).trimStart();
  if (/^(uv run|timeout|time|nice|noglob|command|builtin|exec|nocorrect)\\s+rtk\\b/.test(c)) return true;
  const segments = splitSegments(String(command));
  return segments.length > 0 && segments.every(isRtkSegment);
}`,
  },
  {
    name: 'm7_identity_and_no_log',
    why: '同时去掉恒等抑制与改写日志（验证是否还有独立断言裁判恒等抑制）',
    old: `    if (rewritten && rewritten !== spec.command) {
      log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));`,
    neo: `    if (rewritten) {`,
  },
];

const results = [];
for (const m of MUTANTS) {
  if (!src.includes(m.old)) { results.push({ name: m.name, status: 'BUILD-FAILED' }); continue; }
  const file = path.join(DIR, m.name + '.js');
  writeFileSync(file, src.replace(m.old, m.neo));
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, ['test.js'], {
      encoding: 'utf8',
      env: { ...process.env, RTK_TEST_TARGET: path.relative(ROOT, file).replaceAll('\\\\', '/'), RTK_TEST_FAST: '1' },
      timeout: 300000,
    });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status ?? -1; }
  const t = out.match(/总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/) || [];
  results.push({
    name: m.name, why: m.why, exitCode: code,
    total: t[1], passed: t[2], failed: t[3],
    verdict: code !== 0 ? 'RED(捕获)' : 'GREEN(存活)',
    failedNames: out.split('\n').filter((l) => /^  · \[/.test(l)).slice(0, 10),
  });
}
console.log(JSON.stringify(results, null, 1));
