// 审查实验 2：捕获 execFile 的同步 throw，区分「回调」与「同步抛」两条路径。
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const out = [];
const say = (...a) => out.push(a.join(' '));

function callRtk(bin, args, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) resolve({ outcome: 'HUNG', ms: Date.now() - t0 });
    }, 8000);
    let ret;
    try {
      ret = execFile(bin, args, opts, (err, stdout, stderr) => {
        done = true;
        clearTimeout(timer);
        resolve({
          outcome: 'callback',
          ms: Date.now() - t0,
          errCode: err ? err.code : null,
          errKilled: err ? !!err.killed : false,
          errSignal: err ? err.signal : null,
          errMsg: err ? String(err.message).slice(0, 100) : null,
          stdout: String(stdout || '').slice(0, 80),
          stdoutLen: String(stdout || '').length,
          stderr: String(stderr || '').slice(0, 100),
        });
      });
    } catch (e) {
      done = true;
      clearTimeout(timer);
      resolve({ outcome: 'THROWN_SYNC', ms: Date.now() - t0, code: e.code, errno: e.errno, msg: String(e.message).slice(0, 120), hasReturnedChild: ret !== undefined });
    }
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'rtkrev2-'));
writeFileSync(path.join(dir, 'notexec.txt'), 'x');

const cases = [
  ['ENOENT：bin 完全不存在', 'definitely-not-a-real-rtk-xyz', ['rewrite', 'git status']],
  ['非可执行普通文件', path.join(dir, 'notexec.txt'), ['rewrite', 'git status']],
  ['空串 bin', '', ['rewrite', 'git status']],
  ['目录当 bin', dir, ['rewrite', 'git status']],
];
for (const [name, bin, args] of cases) {
  say('=== ' + name + ' ===');
  say(JSON.stringify(await callRtk(bin, args, { timeout: 5000, windowsHide: true })));
}

// rtk 真实存在时的超长/含换行/空入参
say('=== rtk 特殊入参 ===');
for (const c of ['', '   ', '\n', 'a\nb', 'x'.repeat(200000)]) {
  const r = await callRtk('rtk', ['rewrite', c], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
  say(`len=${c.length} -> ${JSON.stringify(r)}`);
}

// timeout 语义：node 挂起
say('=== timeout 语义 ===');
const slow = path.join(dir, 'slow.mjs');
writeFileSync(slow, 'setTimeout(()=>{}, 60000);');
say(JSON.stringify(await callRtk(process.execPath, [slow], { timeout: 800, windowsHide: true })));

// 大 stdout 超过 maxBuffer 的语义（index.js 未设 maxBuffer，默认 1MB）
say('=== stdout 超 maxBuffer（默认 1MB） ===');
const big = path.join(dir, 'big.mjs');
writeFileSync(big, 'process.stdout.write("x".repeat(3*1024*1024));');
say(JSON.stringify(await callRtk(process.execPath, [big], { timeout: 10000, windowsHide: true })));

console.log(out.join('\n'));
