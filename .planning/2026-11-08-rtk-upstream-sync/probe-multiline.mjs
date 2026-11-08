// 审查实验 5：多行/复合命令的 rewrite 行为，以及改写结果幂等性（是否无限增长）。
import { execFile } from 'node:child_process';

function rewrite(cmd) {
  return new Promise((resolve) => {
    execFile('rtk', ['rewrite', cmd], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '') });
    });
  });
}

const multi = [
  'git status\ngit diff',
  'git status\r\ngit diff',
  'rtk git status\ngit diff',
  'git status\nrtk gain',
  'echo a\n\necho b',
  'git status && git diff',
  'Get-ChildItem; git status',
  'git status; git diff; git log',
];

console.log('## 多行/复合命令 rewrite');
for (const c of multi) {
  const r = await rewrite(c);
  console.log(JSON.stringify(c).padEnd(42) + ' -> code=' + r.code + ' out=' + JSON.stringify(r.out));
}

// 幂等性：连续 rewrite 直到稳定或增长
console.log('\n## 幂等性 / 是否无限增长');
const seeds = ['git   status', 'git status', 'rtk\r\ngit status', 'rtk  git status', 'ls   -la'];
for (const seed of seeds) {
  let cur = seed;
  const chain = [cur];
  for (let i = 0; i < 6; i++) {
    const r = await rewrite(cur);
    const next = r.out.trim();
    if (!next || next === cur) break;
    cur = next;
    chain.push(cur);
  }
  console.log('seed=' + JSON.stringify(seed) + ' chain=' + JSON.stringify(chain));
}
