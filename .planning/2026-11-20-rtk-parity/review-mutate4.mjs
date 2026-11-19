import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const ROOT = path.resolve('.');
const src = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const FN = "export function isRtkInvocation(command) {\n  const text = String(command);\n  // Leading/trailing whitespace must reach rtk, never be skipped: rtk compares the\n  // trimmed line and echoes the trimmed form, so `\"  rtk git status\"` is exit 3 +\n  // `\"rtk git status\"` — a genuine rewrite. Skipping it here would swallow that\n  // normalisation (the one place this fast path disagreed with upstream).\n  if (text !== text.trim()) return false;\n  const segments = splitSegments(text);\n  return segments.length > 0 && segments.every(isRtkSegment);\n}";
if (!src.includes(FN)) {
  console.log(JSON.stringify({ error: 'anchor-not-found', head: src.slice(src.indexOf('export function isRtkInvocation'), src.indexOf('export function isRtkInvocation') + 700) }, null, 1));
  process.exit(0);
}
const MUTANTS = [
  { name: 'mA_no_whitespace_shortcircuit', neo: "export function isRtkInvocation(command) {\n  const segments = splitSegments(String(command));\n  return segments.length > 0 && segments.every(isRtkSegment);\n}" },
  { name: 'mB_flat_prefix_guard', neo: "export function isRtkInvocation(command) {\n  return String(command).trimStart().startsWith('rtk ');\n}" },
  { name: 'mC_prefix_misjudged', neo: "export function isRtkInvocation(command) {\n  const c = String(command).trimStart();\n  if (/^(uv run|timeout|time|nice|noglob|command|builtin|exec|nocorrect)[ ]+rtk\\b/.test(c)) return true;\n  const segments = splitSegments(String(command));\n  return segments.length > 0 && segments.every(isRtkSegment);\n}" },
];
const out = [];
for (const m of MUTANTS) {
  const f = path.join(ROOT, '.planning/2026-11-20-rtk-parity/mutants/' + m.name + '.js');
  writeFileSync(f, src.replace(FN, m.neo));
  let o = '', code = 0;
  try { o = execFileSync(process.execPath, ['test.js'], { encoding: 'utf8', env: { ...process.env, RTK_TEST_TARGET: '.planning/2026-11-20-rtk-parity/mutants/' + m.name + '.js', RTK_TEST_FAST: '1' }, timeout: 300000 }); }
  catch (e) { o = String(e.stdout || '') + String(e.stderr || ''); code = e.status ?? -1; }
  const t = o.match(/总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/) || [];
  out.push({ name: m.name, exitCode: code, total: t[1], passed: t[2], failed: t[3], verdict: code !== 0 ? 'RED(捕获)' : 'GREEN(存活)', failedNames: o.split('\n').filter(l => /^  · \[/.test(l)).slice(0, 6) });
}
console.log(JSON.stringify(out, null, 1));
