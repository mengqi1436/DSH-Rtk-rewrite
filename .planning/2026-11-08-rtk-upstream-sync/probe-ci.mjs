// 审查实验 24（新发现 P1-3）：CI 配置 RTK_TEST_FAST=1 在无 rtk 环境会 FAIL。
// 因为 E1 组没有 FAST 跳过分支。验证修法：用可感知 `--` 的假 rtk 覆盖 E1。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'rtkci-'));
const BIN = path.join(TMP, 'bin');
mkdirSync(BIN, { recursive: true });

// 假 rtk：能感知 `--`（argv[2]），从而同时覆盖 P1-1 的正反两面
writeFileSync(path.join(BIN, 'rewrite'), `'use strict';
const argv = process.argv.slice(2);
const hasDash = argv[0] === '--';
const cmd = hasDash ? argv[1] : argv[0];
const HELP = 'Rewrite a raw command to its RTK equivalent\\n\\nUsage: rtk rewrite [OPTIONS] [ARGS]...';
if (!hasDash && /^-(h|h+)$/.test(cmd)) { process.stdout.write(HELP); process.exit(0); }
if (!hasDash && cmd === '--help') { process.stdout.write(HELP + '\\nExit codes'); process.exit(0); }
if (cmd.startsWith('-')) { process.exit(1); }
if (cmd === 'git status') { process.stdout.write('rtk git status'); process.exit(3); }
process.exit(1);
`);

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(BIN, 'rewrite')], { cwd: BIN, timeout: 10000, windowsHide: true }, () => {});
    execFile(BIN + '/rewrite', [], { shell: false, timeout: 5000 }, () => {});
    resolve(null);
  });
}

// 直接用 node 跑假脚本，模拟 execFile(RTK_BIN, ['rewrite', ...]) 的实际调用形态：
// 测试里 RTK_BIN = process.execPath，cwd = FAKE_BIN，所以 node 会执行 cwd 里的 `rewrite` 脚本，
// argv = ['rewrite', <plugin args...>]。脚本里 process.argv.slice(2) 拿到的正是插件传的参数。
function probe(pluginArgs) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['rewrite', ...pluginArgs], { cwd: BIN, timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '') });
    });
  });
}

console.log('## 假 rtk 能否区分「有 --」与「无 --」');
for (const args of [['-h'], ['--help'], ['-hh'], ['--', '-h'], ['--', '--help'], ['--', '-v'], ['git status'], ['--', 'git status']]) {
  const r = await probe(args);
  const isHelp = /Rewrite a raw command|Usage:|Exit codes/.test(r.out);
  console.log('  ' + JSON.stringify(args).padEnd(24) + ' code=' + String(r.code).padEnd(4) + ' helpText=' + String(isHelp).padEnd(5) + ' out=' + JSON.stringify(r.out).slice(0, 44));
}

console.log('\n## 结论');
console.log('  假 rtk 能感知 argv[0] === "--" → 可以覆盖 P1-1 的正反两面，不需要真 rtk。');
console.log('  修法：E1 组改用假 rtk（或复制该场景到 A 组），FAST 模式下也能验证「加 -- 后不泄露 help 文本」。');

rmSync(TMP, { recursive: true, force: true });
