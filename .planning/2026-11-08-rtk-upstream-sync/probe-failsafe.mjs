// 审查实验：验证 index.js 的失败安全、递归防护、spec 保留等关键路径。
// 全部在进程内构造 fake 环境，不污染仓库。
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const out = [];
const say = (...a) => out.push(a.join(' '));

// ── 实验 A：execFile 在 RTK_BIN 为非法可执行 / 目录 / 空串时的回调行为 ──
function callRtk(bin, args, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) resolve({ hung: true, ms: Date.now() - t0 });
    }, 8000);
    execFile(bin, args, opts, (err, stdout, stderr) => {
      done = true;
      clearTimeout(timer);
      resolve({
        hung: false,
        ms: Date.now() - t0,
        errCode: err ? err.code : null,
        errKilled: err ? !!err.killed : false,
        errSignal: err ? err.signal : null,
        errMsg: err ? String(err.message).slice(0, 120) : null,
        stdout: String(stdout || ''),
        stderr: String(stderr || '').slice(0, 120),
      });
    });
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'rtkrev-'));
writeFileSync(path.join(dir, 'notexec.txt'), 'x');

say('=== A1 bin 不存在 ===');
say(JSON.stringify(await callRtk('definitely-not-a-real-rtk-xyz', ['rewrite', 'git status'], { timeout: 5000, windowsHide: true })));
say('=== A2 bin 指向普通文件（非可执行） ===');
say(JSON.stringify(await callRtk(path.join(dir, 'notexec.txt'), ['rewrite', 'git status'], { timeout: 5000, windowsHide: true })));
say('=== A3 bin 为空串 ===');
say(JSON.stringify(await callRtk('', ['rewrite', 'git status'], { timeout: 5000, windowsHide: true })));

// ── 实验 B：rtk 是真实 rtk 但对特殊命令的行为（用真实 rtk 存在时） ──
say('=== B 特殊入参 ===');
for (const c of ['', '   ', '\n', 'a\nb', 'x'.repeat(200000)]) {
  const r = await callRtk('rtk', ['rewrite', c], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
  say(`cmd=${JSON.stringify(c.length > 40 ? c.slice(0, 40) + '...(' + c.length + ')' : c)} -> ${JSON.stringify({ errCode: r.errCode, hung: r.hung, stdoutLen: r.stdout.length, stdout: r.stdout.slice(0, 60), stderr: r.stderr.slice(0, 80) })}`);
}

// ── 实验 C：execFile 的 err.killed 语义（timeout 触发时） ──
say('=== C timeout 语义（用一个 sleep 脚本） ===');
const slow = path.join(dir, 'slow.mjs');
writeFileSync(slow, 'setTimeout(()=>{}, 60000);');
const c = await callRtk(process.execPath, [slow], { timeout: 800, windowsHide: true });
say(JSON.stringify(c));

console.log(out.join('\n'));
