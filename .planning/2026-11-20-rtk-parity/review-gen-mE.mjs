import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('index.js', 'utf8');
const anchor = '  if (text !== text.trim()) return false;';
if (!src.includes(anchor)) { console.log('ANCHOR-MISSING'); process.exit(0); }
const inject = '  if (/^(uv run|timeout|time|nice|noglob|command|builtin|exec|nocorrect) +rtk$/.test(text) || /^(uv run|timeout|time|nice|noglob|command|builtin|exec|nocorrect) +rtk /.test(text)) return true;';
const out = src.replace(anchor, inject + String.fromCharCode(10) + anchor);
writeFileSync('.planning/2026-11-20-rtk-parity/mutants/mE_prefix_misjudged.js', out);
console.log('written', out.length);
