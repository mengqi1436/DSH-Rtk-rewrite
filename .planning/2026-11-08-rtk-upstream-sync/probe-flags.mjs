// 审查实验 16：精确界定「以 rtk 自身 flag 命名的命令」触发面，并验证 `--` 修法的完备性。
import { execFile } from 'node:child_process';

function raw(args) {
  return new Promise((resolve) => {
    execFile('rtk', args, { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '') });
    });
  });
}

console.log('## 1. 无 `--` 时：哪些「命令文本」会被 clap 当成 flag');
const CANDIDATES = [
  '-h', '--help', '-v', '--version', '--', '--skip-env',
  '--skip-env git status', '--skip-env=1 git status',
  '-h git status', '--help git status',
  'git status --skip-env',
  ' -h', '\t--help',
];
for (const c of CANDIDATES) {
  const r = await raw(['rewrite', c]);
  const isHelp = /Usage:|Options:|Exit codes/.test(r.out);
  console.log(
    '  ' + JSON.stringify(c).padEnd(28) +
      ' code=' + String(r.code).padEnd(4) +
      ' helpText=' + String(isHelp).padEnd(5) +
      ' out=' + JSON.stringify(r.out).slice(0, 60),
  );
}

console.log('\n## 2. 加 `--` 后同一批命令文本的行为（修法验证）');
for (const c of CANDIDATES) {
  const r = await raw(['rewrite', '--', c]);
  const isHelp = /Usage:|Options:|Exit codes/.test(r.out);
  console.log(
    '  ' + JSON.stringify(c).padEnd(28) +
      ' code=' + String(r.code).padEnd(4) +
      ' helpText=' + String(isHelp).padEnd(5) +
      ' out=' + JSON.stringify(r.out).slice(0, 60),
  );
}

console.log('\n## 3. 加 `--` 后正常命令是否行为不变');
const NORMAL = [
  'git status', 'git   status', 'ls -la', 'Get-ChildItem', 'echo hi',
  'git status && git diff', 'ls; git status', 'ls | grep foo',
  'rtk git status', 'git status\ngit diff', 'git status --short',
];
for (const c of NORMAL) {
  const a = await raw(['rewrite', c]);
  const b = await raw(['rewrite', '--', c]);
  const same = a.code === b.code && a.out === b.out;
  console.log(
    '  ' + (same ? 'SAME ' : 'DIFF!') + ' ' + JSON.stringify(c).padEnd(28) +
      ' 无--: code=' + a.code + ' out=' + JSON.stringify(a.out).slice(0, 34) +
      ' | 有--: code=' + b.code + ' out=' + JSON.stringify(b.out).slice(0, 34),
  );
}
