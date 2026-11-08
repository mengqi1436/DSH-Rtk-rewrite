// 审查实验 12：rtk rewrite 的参数解析边界（以 - 开头 / 含 -- / 多个空格 / 空串）。
import { execFile } from 'node:child_process';

function rw(cmd) {
  return new Promise((resolve) => {
    execFile('rtk', ['rewrite', cmd], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || ''), errOut: String(stderr || '').slice(0, 120) });
    });
  });
}

const CASES = [
  '--version', '-h', '--help', '-v',
  'git status --short', '--', '-x ls',
  '   ', '\t', '\n',
  'git  status', 'git\tstatus',
  'git status -- ', 'ls -la --color',
];
for (const c of CASES) {
  const r = await rw(c);
  console.log(
    'cmd=' + JSON.stringify(c).padEnd(24) +
      ' code=' + String(r.code).padEnd(12) +
      ' stdout=' + JSON.stringify(r.out).slice(0, 44).padEnd(46) +
      ' stderr=' + JSON.stringify(r.errOut).slice(0, 40),
  );
}
