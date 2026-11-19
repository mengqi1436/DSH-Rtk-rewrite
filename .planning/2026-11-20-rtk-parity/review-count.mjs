import { readFileSync } from 'node:fs';
const s = readFileSync('.planning/2026-11-20-rtk-parity/probe-parity.mjs', 'utf8');
const i = s.indexOf('const CASES = [');
const j = s.indexOf('];', i);
const body = s.slice(i + 'const CASES = ['.length, j);
const lits = body.match(/'(?:[^'\\\\]|\\\\.)*'/g) || [];
console.log('probe CASES 条目数(字符串字面量):', lits.length);
const t = readFileSync('test.js', 'utf8');
