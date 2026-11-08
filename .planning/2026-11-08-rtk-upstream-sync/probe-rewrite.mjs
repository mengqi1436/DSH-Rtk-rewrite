// 审查用探针：实测 rtk rewrite 的退出码与输出形态矩阵。
// 只读调用 rtk，不修改仓库任何文件。
import { execFile } from 'node:child_process';

const CASES = [
  'git status',
  'git   status',
  'Get-ChildItem',
  'echo hi',
  'ls -la',
  'pwd',
  'rtk git status',
  'rtk.exe git status',
  'rtk  git status',
  'RTK git status',
  'RTK.EXE git status',
  ' rtk git status',
  'cd /tmp && git status',
  'git status | head -5',
  'rtk git status && git diff',
  '"rtk" git status',
  'C:\\Users\\x\\.local\\bin\\rtk.exe git status',
  '/c/Users/x/.local/bin/rtk git status',
  '& rtk git status',
  'rtk gain',
];

function probe(cmd) {
  return new Promise((resolve) => {
    execFile(
      'rtk',
      ['rewrite', cmd],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          cmd,
          errCode: err ? err.code : null,
          killed: err ? !!err.killed : false,
          stdout: String(stdout || ''),
          stderr: String(stderr || '').slice(0, 200),
        });
      },
    );
  });
}

const rows = [];
for (const c of CASES) rows.push(await probe(c));
for (const r of rows) {
  console.log(
    JSON.stringify(r.cmd) +
      ' | errCode=' + JSON.stringify(r.errCode) +
      ' killed=' + r.killed +
      ' | stdout=' + JSON.stringify(r.stdout) +
      ' | stderr=' + JSON.stringify(r.stderr),
  );
}
