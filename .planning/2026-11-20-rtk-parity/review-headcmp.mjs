import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const src = execFileSync('git', ['show', 'HEAD:index.js'], { encoding: 'utf8' });
writeFileSync('.planning/2026-11-20-rtk-parity/mutants/head-index.js', src);
const NEL = String.fromCodePoint(0x85);
const cases = ['rtk git status' + NEL, NEL + 'rtk git status', '  rtk git status', 'rtk git status', 'rtk ls' + NEL];
for (const [tag, file] of [['HEAD(修复前)', './.planning/2026-11-20-rtk-parity/mutants/head-index.js'], ['当前(修复后)', './index.js']]) {
  const m = await import(file + '?t=' + Date.now());
  const row = cases.map(c => JSON.stringify(c) + '=' + m.isRtkInvocation(c)).join('  ');
  console.log(tag, '::', row);
}
