// 审查实验 4：契约取证 —— rtk rewrite --help 的退出码声明 vs 实测；以及 dsh 的 peer 判定调用方式。
import { execFile } from 'node:child_process';

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        errCode: err ? err.code : null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

const helps = [
  ['rtk rewrite --help', ['rewrite', '--help']],
  ['rtk --help', ['--help']],
  ['rtk --version', ['--version']],
];
for (const [name, args] of helps) {
  const r = await run('rtk', args);
  console.log('##### ' + name + '  errCode=' + JSON.stringify(r.errCode));
  console.log((r.stdout || r.stderr).split('\n').filter((l) => /exit|Exit|stdout|0|1|2|3/.test(l)).slice(0, 40).join('\n'));
  console.log('');
}
