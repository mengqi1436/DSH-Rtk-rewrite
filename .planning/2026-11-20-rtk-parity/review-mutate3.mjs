import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const ROOT = path.resolve('.');
const src = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const oldFn = "export function isRtkInvocation(command) {\n  const segments = splitSegments(String(command));\n  return segments.length > 0 && segments.every(isRtkSegment);\n}";
if (!src.includes(oldFn)) { console.log(JSON.stringify({ status: 'BUILD-FAILED', hint: 'function text mismatch' })); process.exit(0); }
const neo = "export function isRtkInvocation(command) {\n  const c = String(command).trimStart();\n  if (/^(uv run|timeout|time|nice|noglob|command|builtin|exec|nocorrect)[ ]+rtk\\b/.test(c)) return true;\n  const segments = splitSegments(String(command));\n  return segments.length > 0 && segments.every(isRtkSegment);\n}";
const file = path.join(ROOT, '.planning/2026-11-20-rtk-parity/mutants/m6b_prefix_misjudged.js');
writeFileSync(file, src.replace(oldFn, neo));
let out = '', code = 0;
try {
  out = execFileSync(process.execPath, ['test.js'], { encoding: 'utf8', env: { ...process.env, RTK_TEST_TARGET: '.planning/2026-11-20-rtk-parity/mutants/m6b_prefix_misjudged.js', RTK_TEST_FAST: '1' }, timeout: 300000 });
} catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status ?? -1; }
const t = out.match(/总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/) || [];
console.log(JSON.stringify({ exitCode: code, total: t[1], passed: t[2], failed: t[3], verdict: code !== 0 ? 'RED(捕获)' : 'GREEN(存活)', failedNames: out.split('\n').filter(l => /^  · \[/.test(l)).slice(0, 12) }, null, 1));
