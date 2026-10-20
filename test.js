/**
 * 最小自检：node test.js
 * 覆盖：真实 rtk 的改写行为、四档退出码判定（假 rtk 桩，真实子进程退出码）、
 * deny 时命令未被 spawn、以及模块加载 / 桌面布局探测链。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('./index.js');
const RtkPwshExecutor = mod.default;
const { rtkRewrite, configureRtk, isRtkDeny, dshPackageJsonCandidates } = mod;

const assert = (cond, name) => {
  if (!cond) { console.error(`FAIL: ${name}`); process.exit(1); }
  console.log(`ok: ${name}`);
};

// ---------- 真实 rtk（本机 rtk 1.0.1 可复现 exit 1 / exit 3） ----------
// 1. 有等价 → 返回改写结果
assert((await rtkRewrite('git status')) === 'rtk git status', 'git status -> rtk git status');
// 2. 无等价 → null（exit 1）
assert((await rtkRewrite('Get-ChildItem')) === null, 'Get-ChildItem -> null (exit 1)');
// 3. 已是 rtk 形式 → 输出原样（execute 层的 rewritten !== command 会跳过替换）
assert((await rtkRewrite('rtk git status')) === 'rtk git status', 'rtk git status -> identity');
// 4. 模块本身可加载且导出类
assert(typeof RtkPwshExecutor === 'function', 'index.js default export is a class');
// 5. 桌面 Electron 布局探测链：拼接规则正确 + 本机真实桌面端（若可读）命中 asar 内内核包
//    asar 内文件只有 Electron 主进程（fs 已 patch）能读；裸 node 下跳过真实命中检查。
const cands = dshPackageJsonCandidates('E:\\Tool\\DSH');
assert(
  cands.some((p) => p.includes('resources') && p.includes('app.asar') && p.includes('dsh')),
  'desktop layout candidate contains resources/app.asar/dsh',
);
const real = dshPackageJsonCandidates('E:\\Tool\\DSH').find((p) => p.includes('app.asar'));
if (existsSync(real)) {
  assert(dshPackageJsonCandidates('E:\\Tool\\DSH').includes(real), 'real desktop install resolves asar kernel package.json');
} else {
  console.log('skip: real desktop asar check needs the Electron main process (bare node cannot read asar)');
}

// ---------- 假 rtk 桩：真实子进程，按命令返回预设 stdout + 退出码 0/1/2/3 ----------
const stubDir = mkdtempSync(path.join(os.tmpdir(), 'fake-rtk-'));
const probeLog = path.join(stubDir, 'probe.log');
const legacyProbeLog = path.join(stubDir, 'probe-legacy.log');
const stubScript = path.join(stubDir, 'fake-rtk.js');
// rtk 每次调用都会打到 stderr 的 hook 噪声（与 deny 无关）。单引号串内含反引号，插值进桩后仍是合法 JS。
const HOOK_NOISE = '[rtk] No hook installed - run `rtk init -g` for automatic token savings';
writeFileSync(stubScript, `const fs = require('node:fs');
const path = require('node:path');
const [, , sub, command] = process.argv;
// 能力探测：rtk >= 1.0 的 \`rewrite --help\` 退出 0。记录次数供"缓存生效"断言。
if (sub === 'rewrite' && command === '--help') {
  fs.appendFileSync(path.join(__dirname, 'probe.log'), 'probe\\n');
  process.stdout.write('Usage: rtk rewrite [OPTIONS] [ARGS]...\\n');
  process.exit(0);
}
// [退出码, stdout, stderr]
const table = {
  'git status': [0, 'rtk git status'],
  'Get-ChildItem': [1, ''],
  'rtk git status': [0, 'rtk git status'],
  'danger-rm': [2, ''],
  'pipeline-block': [2, 'pipeline rule "no external fetches" denied this command'],
  'needs-approval': [3, 'rtk git push'],
  // exit 2 的真实形态：stdout 为空，stderr 只有 hook 噪声（rtk 1.0.1 的 deny 出口不打印内容）
  'noise-deny': [2, '', '${HOOK_NOISE}\\n'],
  // exit 2 且 stdout 混有噪声行 + 真实理由（给未来版本新增 deny 消息留的形态）
  'mixed-deny': [2, '${HOOK_NOISE}\\npipeline rule "no external fetches" denied this command\\n'],
};
const hit = table[command];
if (sub !== 'rewrite' || hit === undefined) {
  process.stderr.write('fake rtk: unexpected argv ' + process.argv.slice(2).join(' ') + '\\n');
  process.exit(64);
}
const [code, out, err] = hit;
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exit(code);
`, 'utf8');
// 用 node.exe 当 bin、桩脚本当前缀 argv：真 execFile、真退出码（err.code 为数字）。
const stub = { bin: process.execPath, prefix: [stubScript] };

// 旧版 rtk 桩：没有 rewrite 子命令，clap 按"用法错误"退出 2 并打印 stderr。
const legacyScript = path.join(stubDir, 'legacy-rtk.js');
writeFileSync(legacyScript, `const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'probe-legacy.log'), 'probe\\n');
process.stderr.write("error: unrecognized subcommand '" + process.argv[3] + "'\\n\\nUsage: rtk [OPTIONS] <COMMAND>\\n");
process.exit(2);
`, 'utf8');
const legacyStub = { bin: process.execPath, prefix: [legacyScript] };

const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

// 6. exit 0 → 改写结果
assert((await rtkRewrite('git status', stub)) === 'rtk git status', 'stub exit 0 -> rewritten command');
// 7. exit 1 → null（静默原样）
assert((await rtkRewrite('Get-ChildItem', stub)) === null, 'stub exit 1 -> null');
// 8. exit 2 无输出 → 可区分的 deny 结果，理由为空
const ruleDeny = await rtkRewrite('danger-rm', stub);
assert(isRtkDeny(ruleDeny) && ruleDeny.message === '', 'stub exit 2 (no output) -> deny result');
// 9. exit 2 且 stdout 带消息 → deny 理由取自 stdout
const pipelineDeny = await rtkRewrite('pipeline-block', stub);
assert(
  isRtkDeny(pipelineDeny) && pipelineDeny.message.includes('pipeline rule'),
  'stub exit 2 (message on stdout) -> deny result carries the message',
);
// 9b. exit 2 时 stderr 只有 hook 噪声、stdout 为空（rtk 1.0.1 的真实形态）
//     → 噪声绝不能成为拒绝理由，message 必须为空，交给默认文案兜底
const noiseDeny = await rtkRewrite('noise-deny', stub);
assert(
  isRtkDeny(noiseDeny) && noiseDeny.message === '',
  'stub exit 2 (hook noise on stderr only) -> message stays empty, noise is not a reason',
);
// 9c. stdout 混有 `[rtk] ` 噪声行 → 只保留真实理由
const mixedDeny = await rtkRewrite('mixed-deny', stub);
assert(
  isRtkDeny(mixedDeny) && mixedDeny.message === 'pipeline rule "no external fetches" denied this command',
  'stub exit 2 (stdout noise + reason) -> message keeps only the real reason',
);
// 10. exit 3 → 改写结果（待宿主审批，本插件按改写执行）
assert((await rtkRewrite('needs-approval', stub)) === 'rtk git push', 'stub exit 3 -> rewritten command');
// 11. 二进制不存在 → null（fail-open 保持）
assert(
  (await rtkRewrite('git status', { bin: path.join(stubDir, 'no-such-rtk.exe') })) === null,
  'missing rtk binary -> null (fail-open)',
);

// ---------- execute 层：deny 时命令绝不落地到 super.execute() ----------
// 拦截父类原型上的 execute，用哨兵返回值代替真实 spawn（不构造 ctx）。
const parentProto = Object.getPrototypeOf(RtkPwshExecutor.prototype);
const realParentExecute = parentProto.execute;
const spawned = [];
parentProto.execute = function (spec) {
  spawned.push(spec);
  return { spawned: true, command: spec.command };
};
const executor = Object.create(RtkPwshExecutor.prototype);
const specFor = (command) => ({
  command,
  workdir: stubDir,
  timeoutMs: 1000,
  onExpiry: 'kill',
  stdoutMaxBytes: 1 << 16,
  sandboxPolicy: { mode: 'workspace-write' },
});

// 让 execute() 走桩而不是本机 rtk
configureRtk(stub);

// 12. deny（规则 deny，无消息）：super.execute 未被调用，结果是失败 + 拒绝说明
spawned.length = 0;
const deniedHandle = await executor.execute(specFor('danger-rm'));
assert(spawned.length === 0, 'deny: super.execute not called (command never spawned)');
assert(deniedHandle.status === 'completed', 'deny: handle is settled (status completed)');
await deniedHandle.done;
const deniedResult = await deniedHandle.result();
assert(deniedResult.exitCode === 2, 'deny: synthesized result exits non-zero (2)');
assert(
  deniedResult.stderr.text.includes('denied this command') && deniedResult.stderr.text.includes('not executed'),
  'deny: result stderr states the command was denied and not executed',
);
assert(deniedResult.sandbox?.denied === false, 'deny: sandbox.denied stays false (rtk denied, not the sandbox)');
assert(deniedHandle.readOutput().delta.includes('denied this command'), 'deny: readOutput exposes the denial note');
assert(deniedHandle.readOutput().delta === '', 'deny: readOutput is consuming (second read is empty)');
assert(deniedHandle.kill() === false, 'deny: kill() is a no-op (no process exists)');
assert(
  deniedHandle.observed.stderr.readFrom(0).text.includes('denied this command'),
  'deny: observed stderr reader exposes the note',
);

// 13. deny（pipeline 消息）：消息进入结果 stderr，仍未 spawn
spawned.length = 0;
const pipelineHandle = await executor.execute(specFor('pipeline-block'));
const pipelineResult = await pipelineHandle.result();
assert(spawned.length === 0, 'pipeline deny: super.execute not called');
assert(pipelineResult.stderr.text.includes('pipeline rule'), 'pipeline deny: rtk message lands in result stderr');

// 13b. 文案缺陷回归：真实 deny 形态（stderr 只有 hook 噪声）下，用户可见的拒绝理由
//      必须是默认文案，不能出现 `[rtk] No hook installed…`
spawned.length = 0;
const noiseHandle = await executor.execute(specFor('noise-deny'));
const noiseResult = await noiseHandle.result();
assert(spawned.length === 0, 'noise deny: super.execute still not called');
assert(
  noiseResult.stderr.text.includes('denied this command') && !noiseResult.stderr.text.includes('[rtk]'),
  'noise deny: result stderr has the default reason and no hook noise',
);

// 14. exit 0 改写：照旧交给 super.execute，spec 其余字段保留
spawned.length = 0;
const rewrittenHandle = await executor.execute(specFor('git status'));
assert(spawned.length === 1 && spawned[0].command === 'rtk git status', 'rewrite: super.execute gets the rewritten command');
assert(spawned[0].workdir === stubDir && spawned[0].timeoutMs === 1000, 'rewrite: other spec fields are preserved');
assert(rewrittenHandle.spawned === true, 'rewrite: handles the super result through');

// 15. exit 1 原样执行
spawned.length = 0;
await executor.execute(specFor('Get-ChildItem'));
assert(spawned.length === 1 && spawned[0].command === 'Get-ChildItem', 'no equivalent: original command runs unrewritten');

// 16. RTK_DISABLED=1 旁路一切（包括 deny）
process.env.RTK_DISABLED = '1';
spawned.length = 0;
await executor.execute(specFor('danger-rm'));
assert(spawned.length === 1 && spawned[0].command === 'danger-rm', 'RTK_DISABLED=1: deny bypassed, command runs unrewritten');
delete process.env.RTK_DISABLED;

// 17. 递归保护：rtk 调用永不改写
spawned.length = 0;
await executor.execute(specFor('rtk git status'));
assert(spawned.length === 1 && spawned[0].command === 'rtk git status', 'rtk command: recursion guard keeps it untouched');

// 18. 能力探测缓存：capable 阶段 6 次 execute 只探测一次（不是每条命令都探）
assert(readLines(probeLog) === 1, `probe: capable rtk probed exactly once across all executions (got ${readLines(probeLog)})`);

// 19. 旧版 rtk（无 rewrite 子命令，clap 对未知子命令 exit 2）：整体降级为 pass-through，
//     绝不能把 clap 的用法错误当成 deny —— 否则这类用户每条命令都会被拒。
configureRtk(legacyStub);
spawned.length = 0;
const legacyHandle = await executor.execute(specFor('danger-rm'));
assert(
  spawned.length === 1 && spawned[0].command === 'danger-rm',
  'legacy rtk (no rewrite subcommand): command runs unrewritten, not denied',
);
assert(legacyHandle.spawned === true, 'legacy rtk: super result passes through (no synthesized deny handle)');
// 20. 降级后完全不尝试改写（连普通命令也不改写）
spawned.length = 0;
await executor.execute(specFor('git status'));
assert(
  spawned.length === 1 && spawned[0].command === 'git status',
  'legacy rtk: no rewrite attempted at all',
);
assert(readLines(legacyProbeLog) === 1, `legacy rtk: probe cached, not re-run per command (got ${readLines(legacyProbeLog)})`);
// 21. 递归保护优先于探测：直接旁路，不再探测
spawned.length = 0;
await executor.execute(specFor('rtk git status'));
assert(spawned.length === 1, 'legacy rtk: recursion guard still bypasses before probing');
assert(readLines(legacyProbeLog) === 1, 'legacy rtk: recursion guard triggered no probe');

// 22. 真实二进制（非桩）降级：RTK_BIN 指到无关程序时也不能让 shell 被拒。
//     node 没有 rewrite 子命令，`<node> rewrite --help` 非 0 退出 → 探测判不支持。
configureRtk({ bin: process.execPath });
spawned.length = 0;
await executor.execute(specFor('danger-rm'));
assert(
  spawned.length === 1 && spawned[0].command === 'danger-rm',
  'unrelated RTK_BIN (real binary): degrades to pass-through, not deny',
);

parentProto.execute = realParentExecute;
configureRtk({});

console.log('ALL PASS');
