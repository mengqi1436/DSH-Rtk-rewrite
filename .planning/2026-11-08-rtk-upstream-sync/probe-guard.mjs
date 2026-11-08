// 审查实验 3：递归防护覆盖面的反例矩阵 + 复现「catch 吞掉 super.execute 异常并重复执行」。
import { execFile } from 'node:child_process';

function rtkRewrite(command) {
  return new Promise((resolve) => {
    execFile(
      'rtk',
      ['rewrite', command],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (!err) { resolve(out || null); return; }
        if (err.code === 'ENOENT') { /* skip */ }
        else if (err.killed) { /* skip */ }
        else if (Number(err.code) === 1) { /* skip */ }
        else if (out) { resolve(out); return; }
        else { /* skip */ }
        resolve(null);
      },
    );
  });
}

// index.js 现行的 guard（逐字复制）
function guardSkips(command) {
  const trimmed = command.trimStart();
  return trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ');
}

const CASES = [
  'rtk git status',
  'rtk.exe git status',
  'rtk  git status',
  'rtk\tgit status',
  'rtk\r\ngit status',
  '  rtk git status',
  '\trtk git status',
  'rtk',
  'rtk ',
  'rtk gain',
  'RTK git status',
  '"rtk" git status',
  '& rtk git status',
  'C:\\Users\\Sjc\\.local\\bin\\rtk.exe git status',
  '/c/Users/Sjc/.local/bin/rtk git status',
  'cd /tmp && rtk git status',
  'rtk git status && git diff',
  'rtk git status; git diff',
  'rtk git status | head -5',
  'echo x; rtk git status',
  'git status',
];

console.log('# cmd | guard跳过? | rtk返回 | 会被实际替换?');
for (const c of CASES) {
  const skipped = guardSkips(c);
  const rw = skipped ? '(未调用)' : await rtkRewrite(c);
  const replaced = skipped ? false : (!!rw && rw !== c);
  console.log(
    JSON.stringify(c).padEnd(52) +
      ' | skip=' + String(skipped).padEnd(5) +
      ' | rtk=' + JSON.stringify(rw).padEnd(46) +
      ' | replace=' + replaced,
  );
}

// ── 复现：super.execute 抛异常时被 catch 吞掉 + 原命令被执行第二次 ──
console.log('\n# 复现 A：改写成败后 super.execute 抛异常 -> catch -> 再执行原命令');
const executed = [];
class FakeSuper {
  async execute(spec) {
    executed.push(spec.command);
    if (spec.command.startsWith('rtk ')) throw new Error('SANDBOX_UNAVAILABLE');
    return { exitCode: 0, cmd: spec.command };
  }
}
async function fakeExecute(spec) {
  const trimmed = spec.command.trimStart();
  if (guardSkips(spec.command)) return new FakeSuper().execute(spec);
  try {
    const rewritten = await rtkRewrite(spec.command);
    if (rewritten && rewritten !== spec.command) {
      return await new FakeSuper().execute({ ...spec, command: rewritten });
    }
  } catch (err) {
    console.log('  caught:', err.message);
  }
  return new FakeSuper().execute(spec);
}
const res = await fakeExecute({ command: 'git status' });
console.log('  result =', JSON.stringify(res));
console.log('  实际执行序列 =', JSON.stringify(executed));
console.log('  >> 结论：若 executed 含两条，说明同一逻辑命令被执行两次，且沙箱异常被吞');
