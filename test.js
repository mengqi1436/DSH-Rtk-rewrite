/**
 * rtk-rewrite 验证套件 —— 零依赖，`node test.js` 直接跑，不引任何测试框架。
 *
 * 设计原则（上一版 test.js 把 rtkRewrite 抄了一份自己测自己，属于「测试重复实现」，
 * 测不出真实代码的任何回归）：
 *
 *  1. 纯函数：index.js 只要导出了可测的判定函数，就直接 import 测（见 PURE_CANDIDATES）。
 *  2. 不可导出的内部路径（rtkRewrite / execute 分支）：用**可注入的假 rtk** 跑真实代码。
 *     假 rtk = `RTK_BIN` 指向 node 可执行体 + cwd 里放一个叫 `rewrite` 的脚本，
 *     由 `FAKE_SCENARIO` 控制 exit 0/1/2/3/7、超时、崩溃；`FAKE_LOG` 记录每次调用，
 *     用来断言「递归防护真的没去调 rtk」。
 *  3. 宿主依赖（@deepseek-ai/dsh-pwsh-sandbox）用一个假包顶上，通过
 *     `DSH_INSTALL_PACKAGE_JSON` 注入，从而不需要 node_modules 也能加载 index.js。
 *  4. 真 rtk 用绝对路径调，做命令族冒烟；rtk 当前行为即时当 oracle，不在测试里硬编码输出。
 *
 * 环境变量：
 *   RTK_TEST_TARGET  被测模块（相对本文件），默认 ./index.js —— 变异测试靠它指向变异副本
 *   RTK_TEST_SOFT=1  把「与上游契约不符但非阻断」的差异降级为 WARN 而非 FAIL（变异测试用）
 *   RTK_TEST_FAST=1  跳过真 rtk 组（F/G），只跑假 rtk 覆盖的逻辑组 —— 变异测试用来提速；
 *                    变异体全部落在 A–E 组的代码路径上，跳过 F/G 不影响捕获能力
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TARGET_PATH = process.env.RTK_TEST_TARGET
  ? path.resolve(ROOT, process.env.RTK_TEST_TARGET)
  : path.join(ROOT, 'index.js');
const SOFT = process.env.RTK_TEST_SOFT === '1';
const FAST = process.env.RTK_TEST_FAST === '1';

// ────────────────────────────── 断言与统计 ──────────────────────────────

const results = [];
/** @param {string} group @param {string} name @param {boolean} ok @param {string} [detail] @param {boolean} [soft] */
function check(group, name, ok, detail, soft = false) {
  results.push({ group, name, ok: !!ok, detail: detail || '', soft });
  return !!ok;
}

/** 与上游契约不符但属「优化/低危」的断言：默认仍 FAIL，SOFT=1 时降级为 WARN。 */
function checkDivergence(group, name, ok, detail) {
  return check(group, name, ok, detail, SOFT);
}

function eq(group, name, actual, expected, soft = false) {
  const ok = actual === expected;
  return check(group, name, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`, soft);
}

// ────────────────────────────── 临时沙箱 ──────────────────────────────

const TMP = path.join(os.tmpdir(), `rtk-rw-verify-${process.pid}`);
const FAKE_BIN = path.join(TMP, 'fakebin');
const FAKE_DSH = path.join(TMP, 'fakedsh');
const LOG_FILE = path.join(TMP, 'rtk-calls.log');

function setupSandbox() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(FAKE_BIN, { recursive: true });
  mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });

  // 假 rtk：node 把 execFile 的第一项（`rewrite`）当脚本路径，因此执行时
  //   process.argv = [node, <.../rewrite>, ...真正传给 rtk 的参数]
  // scriptArgs = process.argv.slice(2) 即「rtk 收到的参数」，不含子命令名：
  //   plugin 传 ['rewrite', cmd]        → scriptArgs = [cmd]
  //   plugin 传 ['rewrite', '--', cmd]  → scriptArgs = ['--', cmd]（P1-1 的修法）
  // 假 rtk 复刻真 rtk 的 clap 语义：未隔离且命令以 "-" 开头 → HELP 文本到 stdout + exit 0。
  // 这样即使 CI runner 上没有 rtk，也能在 P1-1 的正反两面锁住回归。
  //
  // 保真度边界（别拿假 rtk 反推真 rtk 语义）：
  //  - 有 `--` 隔离时，11 条命令上假/真 rtk 输出完全一致（实测差异 0）。
  //  - 无 `--` 时假 rtk 比真 rtk 0.49.0 **更严格**：真 rtk 只对 -h/--help/-hh 吐 help，
  //    假 rtk 对任何 leading-dash 命令都吐。方向是安全的 —— 过严只会让测试更强，
  //    不会造成假绿；但也意味着「假 rtk 通过」不等于「真 rtk 的全部 flag 语义已覆盖」。
  writeFileSync(path.join(FAKE_BIN, 'rewrite'), `'use strict';
const fs = require('node:fs');
const scriptArgs = process.argv.slice(2);
const isolated = scriptArgs[0] === '--';
const cmd = isolated ? (scriptArgs[1] ?? '') : (scriptArgs[0] ?? '');
const scenario = process.env.FAKE_SCENARIO || 'exit3';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ scenario, cmd, isolated, argv: scriptArgs }) + '\\n');
if (cmd.startsWith('-')) {
  // 未隔离：clap 把 -h 当自己的 flag → help 到 stdout + exit 0（P1-1 的成因）
  if (!isolated) {
    process.stdout.write('Rewrite a raw command to its RTK equivalent' + String.fromCharCode(10) + 'Usage: rtk.exe rewrite [OPTIONS] [ARGS]...' + String.fromCharCode(10) + 'Options:');
    process.exit(0);
  }
  // 已隔离：rtk 把 -h 当普通命令文本 → 无可改写内容，exit 1 无输出（实测真 rtk 行为）
  process.exit(1);
}
if (scenario === 'timeout') { setTimeout(() => {}, 120000); }
else if (scenario === 'crash') { throw new Error('fake rtk exploded'); }
else if (scenario === 'crash70') { process.stderr.write('fake rtk exploded' + String.fromCharCode(10)); process.exit(70); }
else if (scenario === 'exit3') { process.stdout.write('rtk ' + cmd); process.exit(3); }
else if (scenario === 'identity') { process.stdout.write(cmd); process.exit(3); }
else if (scenario === 'exit1') { process.exit(1); }
else if (scenario === 'exit0run') { process.stdout.write('rtk ' + cmd); process.exit(0); }
else if (scenario === 'exit0empty') { process.exit(0); }
else if (scenario === 'deny2empty') { process.exit(2); }
else if (scenario === 'whitespace') { process.stdout.write('\\n\\n  rtk ' + cmd + '  \\n\\n'); process.exit(3); }
else if (scenario === 'weird7') { process.stdout.write('rtk weird'); process.exit(7); }
else if (scenario === 'weird7empty') { process.exit(7); }
else if (scenario === 'exit3empty') { process.exit(3); }
else if (scenario === 'blank') { process.stdout.write('   ' + String.fromCharCode(10) + String.fromCharCode(9) + ' ' + String.fromCharCode(10)); process.exit(3); }
else if (scenario === 'crashout') { process.stdout.write('partial'); process.exit(1); }
else if (scenario === 'hugeout') { process.stdout.write('rtk ' + cmd + ' ' + 'x'.repeat(60000)); process.exit(3); }
else { process.exit(0); }
`);

  // 假 dsh 安装：index.js 只从它取 SandboxPwshExecutor，并调用 execute()。
  // 执行器支持上游真实会抛错的形态，由 globalThis.__FAIL_MODE 切换：
  //   sandbox       改写版命令（rtk 前缀）执行时抛 SandboxUnavailableError —— confine 准备失败
  //   abort-always  改写版命令抛 AbortError —— 上游 spawn 前的 throwIfAborted()
  //   abort-check   signal 已取消时抛 AbortError
  //   未设置        正常返回
  writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh-install', version: '0.0.0' }));
  const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs',
  }));
  writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxUnavailableError extends Error {
  constructor(detail) { super('SANDBOX_UNAVAILABLE: ' + detail); this.name = 'SandboxUnavailableError'; }
}
class SandboxPwshExecutor {
  constructor(opts) { this.opts = opts; }
  resolve(spec) { return { ...spec, sandboxResolved: true }; }
  async execute(spec) {
    globalThis.__rtkSpecs = globalThis.__rtkSpecs || [];
    globalThis.__rtkSpecs.push(spec);
    const mode = globalThis.__FAIL_MODE;
    const isRewritten = String(spec.command).startsWith('rtk ');
    // 上游 pwsh-sandbox/src/index.ts:285 —— spawn 前的前置取消检查
    if (mode === 'abort-always' && isRewritten) {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (mode === 'abort-check' && spec.signal && spec.signal.aborted === true) {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    // 上游 :286-290 —— confine 准备失败（沙箱 runner 起不来）
    if (mode === 'sandbox' && isRewritten) {
      throw new SandboxUnavailableError('runner chain broken');
    }
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor, SandboxUnavailableError };
`);
}

function teardownSandbox() {
  rmSync(TMP, { recursive: true, force: true });
}

/** 假 rtk 被调用了几次（读 FAKE_LOG）。 */
function rtkCallCount() {
  if (!existsSync(LOG_FILE)) return 0;
  return readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).length;
}
function rtkCalls() {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function resetRtkCalls() {
  rmSync(LOG_FILE, { force: true });
}

/** 捕获 console.log / console.warn（index.js 在调用时读 console，所以区间捕获有效）。 */
function captureConsole() {
  const orig = { log: console.log, warn: console.warn };
  const buf = { log: [], warn: [] };
  console.log = (...a) => buf.log.push(a.join(' '));
  console.warn = (...a) => buf.warn.push(a.join(' '));
  return { buf, restore() { console.log = orig.log; console.warn = orig.warn; } };
}

// ────────────────────────────── 模块加载 ──────────────────────────────

let loadSeq = 0;
/** A 组跑过一次真实超时后的结果，D 组复用，避免重复等 5 秒。 */
let TIMEOUT_RESULT = null;

/**
 * 以指定 RTK_BIN 加载被测模块（每次加 cache-busting query，让模块级
 * `const RTK_BIN = process.env.RTK_BIN` 重新求值）。
 * @param {string} rtkBin
 */
async function loadExecutor(rtkBin) {
  process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
  process.env.RTK_BIN = rtkBin;
  const url = `${pathToFileURL(TARGET_PATH).href}?load=${++loadSeq}`;
  const mod = await import(url);
  return { mod, executor: new mod.default({}) };
}

const FAKE_RTK_BIN = process.execPath;   // 假 rtk：node + cwd 里的 rewrite 脚本
const MISSING_RTK_BIN = path.join(FAKE_BIN, 'definitely-not-installed-rtk.exe');

/** 跑一次 execute，返回假 dsh 收到的 spec 列表。 */
async function runExecute(executor, spec) {
  globalThis.__rtkSpecs = [];
  const cap = captureConsole();
  let thrown = null;
  try {
    await executor.execute(spec);
  } catch (err) {
    thrown = err;
  } finally {
    cap.restore();
  }
  return { specs: globalThis.__rtkSpecs, thrown, log: cap.buf.log, warn: cap.buf.warn };
}

/** 设置假执行器的失败模式（见 setupSandbox 里 index.cjs 的实现）。 */
function setFailMode(mode) {
  globalThis.__FAIL_MODE = mode || undefined;
}

/** 跑一次 execute 并返回最终交给 super.execute 的 command。 */
async function executedCommand(executor, spec, scenario) {
  if (scenario) process.env.FAKE_SCENARIO = scenario;
  const r = await runExecute(executor, spec);
  if (r.thrown) throw r.thrown;
  if (!r.specs.length) throw new Error('super.execute 从未被调用 —— 命令被吞掉了（失败安全被破坏）');
  return r.specs[r.specs.length - 1].command;
}

// ────────────────────────────── 真 rtk 探测 ──────────────────────────────

function detectRealRtk() {
  try {
    const version = execFileSync('rtk', ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    let bin = 'rtk';
    try {
      const where = execFileSync('where', ['rtk'], { encoding: 'utf8', timeout: 15000 }).split(/\r?\n/)[0].trim();
      if (where) bin = where;
    } catch { /* where 不可用则退回 PATH 名 */ }
    return { available: true, version, bin };
  } catch {
    return { available: false, version: null, bin: null };
  }
}

/** 直接问真 rtk 要「这条命令的正确处理方式」，作为 oracle。 */
function realRewrite(bin, command) {
  return new Promise((resolve) => {
    execFile(bin, ['rewrite', command], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : String(err.code)) : 0,
        out: String(stdout || '').trim(),
      });
    });
  });
}

/** 按上游契约把 rtk 的 (exit, stdout) 映射成「插件最终必须执行的命令」。 */
function expectedCommandFor(command, code, out) {
  if (code === 0 || code === 3) return out || command;   // 有等价：用 stdout；恒等则等于原命令
  return command;                                        // 1=无等价 2=deny 其它=未定义：一律原样执行
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  const env = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    rtk: detectRealRtk(),
    target: path.relative(ROOT, TARGET_PATH),
    mode: SOFT ? ' SOFT' : 'STRICT',
  };
  setupSandbox();
  const cwdBefore = process.cwd();
  // execFile 未指定 cwd，子进程继承父进程 cwd —— 假 rtk 的 `rewrite` 脚本靠这个路由。
  process.chdir(FAKE_BIN);
  process.env.FAKE_LOG = LOG_FILE;

  const real = env.rtk;

  try {
    // ─────────── A. rewrite 契约（假 rtk，覆盖每条退出码分支） ───────────
    const G_A = 'A. rewrite 退出码契约';
    {
      const { executor } = await loadExecutor(FAKE_RTK_BIN);

      // exit 3 + stdout：有等价，必须改写
      eq(G_A, 'exit 3 + stdout → 采用改写结果',
        await executedCommand(executor, { command: 'git status' }, 'exit3'), 'rtk git status');

      // exit 0 + stdout：上游文档的 allow 分支，等价于 exit 3
      eq(G_A, 'exit 0 + stdout → 采用改写结果',
        await executedCommand(executor, { command: 'git status' }, 'exit0run'), 'rtk git status');

      // exit 0 但无输出：异常形态，必须原样执行
      eq(G_A, 'exit 0 无输出 → 原样执行',
        await executedCommand(executor, { command: 'git status' }, 'exit0empty'), 'git status');

      // exit 1：无等价，静默透传
      eq(G_A, 'exit 1 → 原样执行',
        await executedCommand(executor, { command: 'git status' }, 'exit1'), 'git status');

      // exit 1 是上游定义的正常分支，不应产生告警噪声
      {
        process.env.FAKE_SCENARIO = 'exit1';
        const r = await runExecute(executor, { command: 'git status' });
        check(G_A, 'exit 1 是正常分支 → 不产生告警', r.warn.length === 0, `实际告警: ${JSON.stringify(r.warn)}`);
      }

      // stdout === 原命令：rtk 对已是 rtk 形态的命令原样回吐（decision.rs:412-417，不做恒等抑制）。
      // 用非 rtk 开头的命令触发，确保真的走到 rtk（而不是被递归防护拦掉），
      // 才能真正覆盖 index.js 里 `rewritten !== spec.command` 这条分支。
      {
        resetRtkCalls();
        process.env.FAKE_SCENARIO = 'identity';
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_A, '恒等输出 → 最终执行原命令', r.specs.at(-1)?.command, 'git status');
        eq(G_A, '恒等输出 → 只调用一次 super.execute（无循环）', r.specs.length, 1);
        eq(G_A, '恒等输出 → 只 spawn 一次 rtk（无循环）', rtkCallCount(), 1);
        check(G_A, '恒等输出 → 不打印改写日志（因为没有实际改写）', r.log.length === 0, `实际日志: ${JSON.stringify(r.log)}`);
      }

      // 上游 rewrite_cmd.rs:122 用 `process::exit(2)` 直接退出，全仓仅此一处 →
      // exit 2 恒无输出。「exit 2 带消息」是不存在的组合，不构造该用例。
      // 语义上是 deny：插件的定位是「透传桥、绝不阻断」，所以正确行为是原样执行。
      eq(G_A, 'exit 2（deny，恒无输出）→ 原样执行',
        await executedCommand(executor, { command: 'git status' }, 'deny2empty'), 'git status');
      {
        // exit 2 是上游定义的正常分支，不属「异常」——不应产生告警噪声
        process.env.FAKE_SCENARIO = 'deny2empty';
        const r = await runExecute(executor, { command: 'git status' });
        check(G_A, 'exit 2 是已定义分支 → 不产生告警', r.warn.length === 0, `实际告警: ${JSON.stringify(r.warn)}`);
      }

      // 上游未定义的退出码：安全优先，不采纳来源不明的 stdout
      checkDivergence(G_A, 'exit 7 + 输出（未定义码）→ 原样执行',
        (await executedCommand(executor, { command: 'git status' }, 'weird7')) === 'git status',
        `实际执行: ${JSON.stringify(await executedCommand(executor, { command: 'git status' }, 'weird7'))}`);

      eq(G_A, 'exit 7 无输出 → 原样执行',
        await executedCommand(executor, { command: 'git status' }, 'weird7empty'), 'git status');
      // 异常退出码且无输出 → 必须告警（否则故障被静默吞掉，用户永远看不见 rtk 坏了）
      {
        process.env.FAKE_SCENARIO = 'weird7empty';
        const r = await runExecute(executor, { command: 'git status' });
        check(G_A, 'exit 7 无输出 → 产生告警', r.warn.length === 1, `实际 ${r.warn.length} 条: ${JSON.stringify(r.warn)}`);
        check(G_A, 'exit 7 告警文案含退出码', /\b7\b/.test(r.warn[0] || ''), `实际: ${JSON.stringify(r.warn[0])}`);
      }
      // exit 3 却无输出：契约上不可能（3 必带 stdout），属异常，必须告警
      {
        process.env.FAKE_SCENARIO = 'exit3empty';
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_A, 'exit 3 无输出 → 原样执行', r.specs.at(-1)?.command, 'git status');
        check(G_A, 'exit 3 无输出 → 产生告警', r.warn.length === 1, `实际 ${r.warn.length} 条: ${JSON.stringify(r.warn)}`);
      }
      // 未捕获异常退出（node 默认 exit 1）：1 是上游定义的「无等价」，静默透传是对的，
      // 不应告警，也不应把 stderr 当命令。真正的「未定义码崩溃」见下文 crash70。
      {
        process.env.FAKE_SCENARIO = 'crash';
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_A, '子进程抛异常（exit 1）→ 原样执行', r.specs.at(-1)?.command, 'git status');
      }
      // rtk stdout 只有空白（无实质内容）→ 视作无输出
      {
        process.env.FAKE_SCENARIO = 'blank';
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_A, 'stdout 只有空白 → 原样执行', r.specs.at(-1)?.command, 'git status');
      }
      // rtk stdout 前后带空白/换行：必须 trim 后取用，否则会把换行带进 shell
      eq(G_A, 'stdout 前后带空白/换行 → trim 后取用',
        await executedCommand(executor, { command: 'git status' }, 'whitespace'), 'rtk git status');

      // 超时：5s 后杀死，原样执行。这条最慢（真等 5s），只跑一次，结果在 D 组复用。
      // 备注：Node 的超时 err 同时带 killed=true 和 signal='SIGTERM'，所以「killed 判定」与
      // 「signal 判定」在行为上等价（M13 是等价变异体，非测试缺口）。这里额外断言告警文案，
      // 作为对「走的是超时分支而不是 else 分支」的区分性证据。
      {
        const t0 = Date.now();
        process.env.FAKE_SCENARIO = 'timeout';
        const r = await runExecute(executor, { command: 'git status' });
        const ms = Date.now() - t0;
        TIMEOUT_RESULT = { cmd: r.specs.at(-1)?.command, ms, warn: r.warn };
        eq(G_A, '超时 → 原样执行', TIMEOUT_RESULT.cmd, 'git status');
        check(G_A, '超时判定发生在 5000ms 量级', ms >= 4500 && ms < 15000, `实测 ${ms}ms`);
        check(G_A, '超时 → 告警文案提到 timeout', /timeout|timed out/i.test(r.warn.join(' ')),
          `实际告警: ${JSON.stringify(r.warn)}`);
      }

      // 崩溃：进程以非 0/1/2/3 退出且 stderr 有内容、stdout 空 → 未定义码分支 → 原样执行 + 告警。
      // （注意不能用 exit 1 模拟崩溃：1 是上游定义的「无等价」，插件的静默透传是对的。）
      {
        process.env.FAKE_SCENARIO = 'crash70';
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_A, '子进程崩溃（exit 70）→ 原样执行', r.specs.at(-1)?.command, 'git status');
        check(G_A, '子进程崩溃（exit 70）→ 产生告警', r.warn.length >= 1, `实际 ${r.warn.length} 条: ${JSON.stringify(r.warn)}`);
      }
      // stderr 是错误输出而非改写结果：即使有 stderr，也不能把它当命令执行
      {
        process.env.FAKE_SCENARIO = 'crash70';
        const r = await runExecute(executor, { command: 'git status' });
        check(G_A, 'stderr 内容不会被当作命令执行',
          !JSON.stringify(r.specs).includes('fake rtk exploded'), `实际 spec: ${JSON.stringify(r.specs)}`);
      }
      // 非零退出但有 stdout（exit 1 带输出）：上游契约 1 = 无改写，stdout 不可信 → 原样执行
      {
        process.env.FAKE_SCENARIO = 'crashout';
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_A, 'exit 1 却带 stdout（契约外）→ 原样执行', r.specs.at(-1)?.command, 'git status');
      }
    }

    // ─────────── B. ENOENT 与单次告警 ───────────
    const G_B = 'B. rtk 缺失（ENOENT）';
    {
      const { executor } = await loadExecutor(MISSING_RTK_BIN);
      process.env.FAKE_SCENARIO = 'exit3';
      const r1 = await runExecute(executor, { command: 'git status' });
      eq(G_B, 'ENOENT → 原样执行', r1.specs.at(-1)?.command, 'git status');
      check(G_B, 'ENOENT → 告警一次', r1.warn.length === 1, `实际 ${r1.warn.length} 条: ${JSON.stringify(r1.warn)}`);
      check(G_B, 'ENOENT → 告警文案提到 rtk 与 PATH', /not found|ENOENT|PATH/i.test(r1.warn[0] || ''), `实际: ${JSON.stringify(r1.warn[0])}`);

      const r2 = await runExecute(executor, { command: 'ls -la' });
      eq(G_B, 'ENOENT 后续调用 → 仍原样执行', r2.specs.at(-1)?.command, 'ls -la');
      check(G_B, 'ENOENT 后续调用 → 不重复告警', r2.warn.length === 0, `实际 ${r2.warn.length} 条`);
    }

    // ─────────── C. 递归防护（假 rtk + 调用计数） ───────────
    const G_C = 'C. 递归防护';
    {
      const { executor } = await loadExecutor(FAKE_RTK_BIN);
      process.env.FAKE_SCENARIO = 'exit3';

      // 上游 registry.rs:836 的判定：`!has_compound && (starts_with("rtk ") || == "rtk")`
      // —— 只对**非复合**命令做恒等短路。插件侧的最优行为同样是不必再 spawn 一次 rtk。
      const guardCases = [
        ['裸 rtk', 'rtk'],
        ['rtk 前缀命令', 'rtk git status'],
        ['rtk.exe 前缀命令', 'rtk.exe git status'],
        ['大小写变体 RTK', 'RTK git status'],
        ['大小写变体 RTK.EXE', 'RTK.EXE git status'],
        ['绝对路径 rtk.exe', 'C:\\Users\\Sjc\\.local\\bin\\rtk.exe git status'],
        ['正斜杠绝对路径', 'C:/Users/Sjc/.local/bin/rtk.exe git status'],
        ['相对路径 ./rtk', './rtk git status'],
        ['POSIX 绝对路径', '/usr/local/bin/rtk git status'],
        ['双引号形式', '"rtk" git status'],
        ['单引号形式', "'rtk' git status"],
        ['env 前缀', 'RTK_DISABLED=1 rtk git status'],
        ['前置空白 + rtk', '   rtk git status'],
      ];
      for (const [label, cmd] of guardCases) {
        resetRtkCalls();
        const executed = await executedCommand(executor, { command: cmd });
        const calls = rtkCallCount();
        // 红线：无论是否跳过，最终执行的绝不能出现 `rtk rtk` / `rtk rtk.exe`
        check(G_C, `${label} → 不产生 rtk rtk 双重改写`, !/(^|\s)rtk(\.exe)?\s+rtk(\.exe)?(\s|$)/i.test(executed),
          `实际执行: ${JSON.stringify(executed)}`);
        // 红线：命令不能被破坏（要么原样，要么被 rtk 加了一层前缀）
        check(G_C, `${label} → 命令内容不被破坏`,
          executed === cmd || executed.replace(/^rtk\s+/i, '') === cmd,
          `实际执行: ${JSON.stringify(executed)}`);
        // 优化断言：不该再 spawn 一次 rtk（上游已认定为 rtk 形式）
        checkDivergence(G_C, `${label} → 不调用 rtk rewrite`, calls === 0, `实际调用 ${calls} 次: ${JSON.stringify(rtkCalls())}`);
      }

      // ★ 关键反例（lead 指定，最容易写错的地方）：
      // `ls -la && rtk git status` → rtk 实测返回 `rtk ls -la && rtk git status`（首段需要改写）。
      // 所以「串里出现 rtk 就整体跳过」是错的，必须整串交给 rtk 逐段处理。
      {
        resetRtkCalls();
        const cmd = 'ls -la && rtk git status';
        const executed = await executedCommand(executor, { command: cmd });
        check(G_C, '★ 反例：`ls -la && rtk git status` 必须交给 rtk（首段需改写）',
          rtkCallCount() >= 1,
          `实际调用 rtk ${rtkCallCount()} 次 —— 含 rtk 子句的复合命令被整体跳过了`);
        check(G_C, '★ 反例：首段被正常改写', /^rtk\s+ls\s+-la\s+&&/.test(executed), `实际执行: ${JSON.stringify(executed)}`);
        check(G_C, '★ 反例：不产生 rtk rtk 双重改写', !/(^|\s)rtk\s+rtk\s/.test(executed), `实际执行: ${JSON.stringify(executed)}`);
      }

      // 后置位置：命令里含 rtk 但不在开头 —— 必须交给 rtk 处理，绝不能整体跳过
      const positional = [
        ['; 后置', 'ls; rtk git status'],
        ['&& 后置', 'ls && rtk git status'],
        ['| 后置', 'ls | rtk grep foo'],
        ['|| 后置', 'false || rtk git status'],
        ['换行分隔', 'ls -la\nrtk git status'],
      ];
      for (const [label, cmd] of positional) {
        resetRtkCalls();
        const executed = await executedCommand(executor, { command: cmd });
        check(G_C, `${label} → 交给 rtk 处理`, rtkCallCount() >= 1, '未调用 rtk rewrite，后置 rtk 段失去保护');
        check(G_C, `${label} → 不产生 rtk rtk`, !/(^|\s)rtk\s+rtk\s/.test(executed), `实际执行: ${JSON.stringify(executed)}`);
      }

      // 不含 rtk 的普通命令必须照常改写（防止防护误伤到 startsWith/includes 过宽）
      resetRtkCalls();
      eq(G_C, '普通命令不受防护影响', await executedCommand(executor, { command: 'git status' }), 'rtk git status');
      check(G_C, '普通命令确实调用了 rtk rewrite', rtkCallCount() === 1, `实际调用 ${rtkCallCount()} 次`);
    }

    // ─────────── D. 失败安全：所有失败路径都执行原命令 ───────────
    const G_D = 'D. 失败安全';
    {
      const { executor } = await loadExecutor(FAKE_RTK_BIN);
      // 硬约束：任何失败路径都必须至少把一条命令交给 super.execute（绝不吞命令、绝不抛异常）。
      // 「失败后执行的是不是**原**命令」由 A 组按退出码语义逐条断言，这里不重复判定。
      // timeout 已在 A 组测过（最慢的一条），这里跳过避免重复等 5 秒。
      for (const scenario of ['exit1', 'exit0empty', 'deny2empty', 'weird7', 'weird7empty', 'crash']) {
        process.env.FAKE_SCENARIO = scenario;
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_D, `场景 ${scenario} → 不抛异常`, r.thrown, null);
        check(G_D, `场景 ${scenario} → 命令未被吞掉`, r.specs.length === 1, `super.execute 调用 ${r.specs.length} 次`);
      }
      // 契约明确的原样执行场景（0 无输出 / 1 / 2 / 崩溃）
      for (const scenario of ['exit1', 'exit0empty', 'deny2empty', 'crash']) {
        eq(G_D, `场景 ${scenario} → 原命令被执行`,
          await executedCommand(executor, { command: 'git status' }, scenario), 'git status');
      }
      // 进程挂死：execFile 回调永远不触发，必须由 timeout 兜底而不是永远挂起（复用 A 组结果）
      if (TIMEOUT_RESULT) {
        eq(G_D, '挂死进程 → timeout 兜底并原样执行', TIMEOUT_RESULT.cmd, 'git status');
        check(G_D, '挂死进程 → 在 5s 量级内返回，不会无限挂起', TIMEOUT_RESULT.ms < 15000, `实测 ${TIMEOUT_RESULT.ms}ms`);
      }
      // 超长命令
      const longCmd = `echo ${'a'.repeat(4000)}`;
      eq(G_D, '4000 字符命令 → 不抛异常且交回原命令',
        await executedCommand(executor, { command: longCmd }, 'exit1'), longCmd);
      // 含换行 / 特殊字符的命令
      const nasty = 'git status\nls -la';
      eq(G_D, '含换行的命令 → 原样交回', await executedCommand(executor, { command: nasty }, 'exit1'), nasty);
      const quoted = 'git log --format="%h %s"';
      eq(G_D, '含双引号的命令 → 原样交回', await executedCommand(executor, { command: quoted }, 'exit1'), quoted);

      // RTK_DISABLED=1：这是**插件自加**的开关（index.js:138），
      // 不是 rtk 的开关 —— 实测 `RTK_DISABLED=1 rtk rewrite 'git status'` 照改 exit 3。
      // 所以断言只能是「插件层跳过 rewrite 调用」，不能断言「rtk 不生效」。
      process.env.RTK_DISABLED = '1';
      try {
        resetRtkCalls();
        eq(G_D, 'RTK_DISABLED=1 → 原样执行', await executedCommand(executor, { command: 'git status' }, 'exit3'), 'git status');
        check(G_D, 'RTK_DISABLED=1 → 插件层完全不调用 rtk', rtkCallCount() === 0, `实际调用 ${rtkCallCount()} 次`);
      } finally {
        delete process.env.RTK_DISABLED;
      }
      // 反向守护：RTK_DISABLED 取其它值时不应误触发跳过
      for (const v of ['0', 'true', 'yes', '']) {
        process.env.RTK_DISABLED = v;
        try {
          resetRtkCalls();
          const executed = await executedCommand(executor, { command: 'git status' }, 'exit3');
          eq(G_D, `RTK_DISABLED=${JSON.stringify(v)} → 不跳过改写`, executed, 'rtk git status');
        } finally {
          delete process.env.RTK_DISABLED;
        }
      }

      // 沙箱字段不丢失
      process.env.FAKE_SCENARIO = 'exit3';
      const spec = {
        command: 'git status', workdir: 'D:\\work', timeoutMs: 12345,
        env: { A: '1' }, stdin: 'input', signal: 'SIG', sandboxPolicy: { mode: 'readonly' }, extra: 42,
      };
      const r = await runExecute(executor, spec);
      const got = r.specs.at(-1) || {};
      eq(G_D, '改写后 command 变了', got.command, 'rtk git status');
      for (const field of ['workdir', 'timeoutMs', 'env', 'stdin', 'signal', 'sandboxPolicy', 'extra']) {
        check(G_D, `沙箱字段 ${field} 原样透传`,
          JSON.stringify(got[field]) === JSON.stringify(spec[field]),
          `期望 ${JSON.stringify(spec[field])}，实际 ${JSON.stringify(got[field])}`);
      }
    }

    // ─────────── D2. 同步异常路径（rtkRewrite 内部抛错 → catch 必须透传） ───────────
    const G_D2 = 'D2. 同步异常（catch 分支）';
    {
      const { executor } = await loadExecutor(FAKE_RTK_BIN);
      process.env.FAKE_SCENARIO = 'exit3';
      // 命令里含 NUL 字节时，`execFile(RTK_BIN, ['rewrite', command])` 会**同步抛**
      // ERR_INVALID_ARG_VALUE —— 它在 Promise executor 里抛出会变成 rejected Promise，
      // 只能由 execute() 的 try/catch 接住。这是不依赖 mock 覆盖 catch 分支的真实路径。
      const nulCmd = 'git' + String.fromCharCode(0) + 'status';
      const r = await runExecute(executor, { command: nulCmd });
      eq(G_D2, 'rtkRewrite 同步抛错 → 不向调用方抛异常', r.thrown, null);
      check(G_D2, 'rtkRewrite 同步抛错 → 原命令仍被执行',
        r.specs.at(-1)?.command === nulCmd, `实际执行: ${JSON.stringify(r.specs.at(-1)?.command)}`);
      check(G_D2, 'rtkRewrite 同步抛错 → 产生 rewrite failed 告警',
        r.warn.some((w) => /rewrite failed/i.test(w)), `实际告警: ${JSON.stringify(r.warn)}`);
      // 后续正常命令不受影响（catch 未污染模块状态）
      eq(G_D2, '同步抛错后 → 正常命令恢复改写',
        await executedCommand(executor, { command: 'git status' }, 'exit3'), 'rtk git status');
    }

    // ─────────── E0. 执行失败必须上抛（锁 P0-1，与 D2「改写失败该吞」相反方向） ───────────
    // 关键区分：
    //   · 改写失败（rtk 挂了/无等价）→ 该吞，继续执行原命令   ← D/D2 组已覆盖
    //   · 执行失败（沙箱建不起来 / 用户已取消）→ 不该吞，必须原样上抛给调用方
    // 若把 super.execute 放进 try，这两件事会被混淆：异常被吞成一条 warn，
    // 且兜底的 return super.execute(spec) 会把同一条命令再提交一次。
    const G_E0 = 'E0. 执行失败必须上抛（P0-1）';
    {
      const { executor } = await loadExecutor(FAKE_RTK_BIN);
      process.env.FAKE_SCENARIO = 'exit3';

      // 1) 沙箱异常必须上抛，且命令只执行一次
      {
        setFailMode('sandbox');
        const r = await runExecute(executor, { command: 'git status' });
        setFailMode(null);
        check(G_E0, '沙箱 SandboxUnavailableError → 必须向调用方抛出',
          r.thrown !== null, '异常被吞掉了，调用方以为命令执行成功');
        eq(G_E0, '沙箱 SandboxUnavailableError → 异常类型原样保留',
          r.thrown?.name, 'SandboxUnavailableError');
        eq(G_E0, '沙箱 SandboxUnavailableError → 命令只执行 1 次（不是 2 次）',
          r.specs.length, 1);
        check(G_E0, '沙箱 SandboxUnavailableError → 不得降级成 warn',
          !r.warn.some((w) => /rewrite failed/i.test(w)), `实际告警: ${JSON.stringify(r.warn)}`);
      }

      // 2) 已取消的 signal 必须上抛 AbortError，且原命令执行 0 次
      {
        const ac = new AbortController();
        ac.abort();
        setFailMode('abort-always');
        const r = await runExecute(executor, { command: 'git status', signal: ac.signal });
        setFailMode(null);
        check(G_E0, '已取消（AbortError）→ 必须向调用方抛出',
          r.thrown !== null, '取消被吞掉了，用户取消的命令仍会跑');
        eq(G_E0, '已取消（AbortError）→ 异常类型原样保留', r.thrown?.name, 'AbortError');
        eq(G_E0, '已取消（AbortError）→ 最终执行次数为 0（原命令不得被再执行一次）',
          r.specs.length, 1);
        check(G_E0, '已取消 → 没有任何 spec 落到非 rtk 的裸原命令',
          r.specs.every((s) => String(s.command).startsWith('rtk ')),
          `实际调用序列: ${JSON.stringify(r.specs.map((s) => s.command))}`);
      }

      // 3) 上游 spawn 前置取消检查（signal 已 abort）→ 同样必须上抛
      {
        const ac = new AbortController();
        ac.abort();
        setFailMode('abort-check');
        const r = await runExecute(executor, { command: 'git status', signal: ac.signal });
        setFailMode(null);
        eq(G_E0, '前置取消检查（signal.aborted）→ 抛 AbortError', r.thrown?.name, 'AbortError');
        eq(G_E0, '前置取消检查（signal.aborted）→ 执行 1 次后即终止', r.specs.length, 1);
      }

      // 4) 对照组：正常路径下改写后只执行一次
      {
        setFailMode(null);
        const r = await runExecute(executor, { command: 'git status' });
        eq(G_E0, '对照：正常路径 → 执行 1 次', r.specs.length, 1);
        eq(G_E0, '对照：正常路径 → 执行的是改写版', r.specs[0]?.command, 'rtk git status');
      }

      // 5) 失败模式复位后，模块不被污染
      eq(G_E0, '沙箱异常后 → 后续命令恢复正常改写',
        await executedCommand(executor, { command: 'git status' }, 'exit3'), 'rtk git status');
      setFailMode(null);
    }

    // ─────────── E1. 以 - 开头的命令不得把 help 文本当命令（锁 P1-1） ───────────
    // `rtk rewrite -h` 会让 clap 把帮助打到 stdout 并 exit 0；若插件用 `rewrite <cmd>`
    // 直接传，帮助文本就会被当成「改写结果」交给 shell 执行。修法是加 `--` 隔离。
    //
    // 分两半：
    //   E1a 假 rtk —— 任何环境都跑（假 rtk 复刻 clap 语义，无 rtk 的 CI 也能锁 P1-1）
    //   E1b 真 rtk —— 只在非 FAST 且有 rtk 时跑（拿真实 clap 行为做额外确认）
    const G_E1 = 'E1a. 以 - 开头的命令（假 rtk，任何环境都跑）';
    {
      const { executor } = await loadExecutor(FAKE_RTK_BIN);
      process.env.FAKE_SCENARIO = 'exit3';

      // 1) 帮助文本绝不能被当命令执行，且最终执行内容必须等于原命令
      const dashCases = ['-h', '--help', '-hh', '-v', '--version', '--', '--skip-env', '-help', '--HELP', '-H', '-x ls'];
      for (const cmd of dashCases) {
        resetRtkCalls();
        const executed = await executedCommand(executor, { command: cmd });
        check(G_E1, `「${cmd}」→ 最终执行内容不得是 help 文本`,
          !/^Rewrite a raw command/m.test(executed) && !/^Usage:/m.test(executed) && !/^Options:/m.test(executed),
          `实际执行: ${JSON.stringify(String(executed).slice(0, 120))}`);
        eq(G_E1, `「${cmd}」→ 最终执行的就是原命令`, executed, cmd);
        // 2) 隔离符确实传给了 rtk（防止「碰巧通过」）
        const calls = rtkCalls();
        check(G_E1, `「${cmd}」→ 调用 rtk 时带了 -- 隔离符`,
          calls.length === 1 && calls[0].isolated === true,
          `实际 argv: ${JSON.stringify(calls[0]?.argv)}`);
      }

      // 3) 反向守护：正常命令不得被加 `--`（否则 rtk 会把 -- 当命令的一部分）
      for (const cmd of ['git status --short', 'ls -la', 'git status && git diff', 'git log --oneline -5', 'cargo test --all']) {
        resetRtkCalls();
        const executed = await executedCommand(executor, { command: cmd });
        eq(G_E1, `正常命令「${cmd}」→ 被正常改写`, executed, `rtk ${cmd}`);
        const calls = rtkCalls();
        check(G_E1, `正常命令「${cmd}」→ 未被加 -- 隔离符`,
          calls.length === 1 && calls[0].isolated === false,
          `实际 argv: ${JSON.stringify(calls[0]?.argv)}`);
      }

      // 4) 首字符是空格但实际以 - 开头：trimStart 后应以 - 判断
      resetRtkCalls();
      const padded = '  -h';
      const executedPadded = await executedCommand(executor, { command: padded });
      check(G_E1, '前置空白的「  -h」→ 不得执行 help 文本',
        !/^Usage:/m.test(executedPadded), `实际执行: ${JSON.stringify(String(executedPadded).slice(0, 80))}`);
    }

    // E1b：真 rtk 分支（FAST 或无 rtk 时跳过）
    const G_E1B = 'E1b. 以 - 开头的命令（真 rtk）';
    if (FAST) {
      check(G_E1B, 'FAST 模式跳过真 rtk 确认（假 rtk 已完整覆盖 P1-1）', true);
    } else if (!real.available) {
      check(G_E1B, '真实 rtk 可用', false, '未找到 rtk，无法用真实 clap 行为确认 P1-1（假 rtk 已覆盖）');
    } else {
      const { executor } = await loadExecutor(real.bin);
      const dashCases = ['-h', '--help', '-hh', '-v', '--version', '--', '--skip-env', '-help', '--HELP', '-H'];
      for (const cmd of dashCases) {
        const executed = await executedCommand(executor, { command: cmd });
        check(G_E1B, `真 rtk「${cmd}」→ 最终执行内容不得是 help 文本`,
          !/^Rewrite a raw command/m.test(executed) && !/^Usage:/m.test(executed) && !/^Options:/m.test(executed),
          `实际执行: ${JSON.stringify(String(executed).slice(0, 120))}`);
        eq(G_E1B, `真 rtk「${cmd}」→ 最终执行的就是原命令`, executed, cmd);
      }
      // 记录 rtk 侧事实：不加 -- 时 -h 会吐出 help 并 exit 0，这正是 P1-1 的成因
      for (const cmd of ['-h', '--help', '-hh']) {
        const noIso = await new Promise((resolve) => {
          execFile(real.bin, ['rewrite', cmd], { timeout: 20000, windowsHide: true }, (err, stdout) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : String(err.code)) : 0, len: String(stdout || '').length });
          });
        });
        const withIso = await new Promise((resolve) => {
          execFile(real.bin, ['rewrite', '--', cmd], { timeout: 20000, windowsHide: true }, (err, stdout) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : String(err.code)) : 0, len: String(stdout || '').length });
          });
        });
        check(G_E1B, `成因取证：rewrite "${cmd}" 无 -- → exit ${noIso.code}/${noIso.len}字节，有 -- → exit ${withIso.code}/${withIso.len}字节`,
          noIso.code === 0 && noIso.len > 0 && withIso.code === 1 && withIso.len === 0,
          `未加 -- 时 exit=${noIso.code} 输出 ${noIso.len} 字节；加 -- 后 exit=${withIso.code} 输出 ${withIso.len} 字节`);
      }
      // 正向防回归：正常命令改写结果不变
      for (const cmd of ['git status --short', 'ls -la', 'git status && git diff', 'git log --oneline -5', 'cargo test --all']) {
        const direct = await realRewrite(real.bin, cmd);
        const executed = await executedCommand(executor, { command: cmd });
        eq(G_E1B, `真 rtk 正向：${cmd} → 改写结果与 rtk 契约一致`, executed, expectedCommandFor(cmd, direct.code, direct.out),
          `rtk exit=${direct.code} out=${JSON.stringify(direct.out)}`);
        check(G_E1B, `真 rtk 正向：${cmd} → 未被 help 文本污染`, !/^Usage:/m.test(executed), `实际: ${JSON.stringify(executed)}`);
      }
    }

    // ─────────── E. 纯函数单测（若 index.js 导出） ───────────
    const G_E = 'E. 纯函数单测';
    {
      const { mod } = await loadExecutor(FAKE_RTK_BIN);
      const candidates = ['isRtkInvocation', 'isAlreadyRtk', 'isRtkCommand', 'shouldSkipRewrite', 'skipRewrite', 'needsRecursionGuard', 'isRecursiveRtk'];
      const found = candidates.filter((n) => typeof mod[n] === 'function');
      if (!found.length) {
        check(G_E, '导出可测的递归防护纯函数', false,
          `未从 index.js 导出以下任一名字: ${candidates.join(', ')} —— 递归防护只能靠行为测试间接覆盖，建议导出纯函数`);
      } else {
        check(G_E, `找到纯函数导出: ${found.join(', ')}`, true);
        for (const name of found) {
          const fn = mod[name];
          // 应判为「已是 rtk 调用」——与上游 registry.rs:836/2008 的意图一致，且覆盖更多写法
          const yes = [
            'rtk', 'rtk git status', 'rtk.exe git status',
            'RTK git status', 'RTK.EXE git status', 'Rtk Git Status',
            'C:\\Users\\x\\.local\\bin\\rtk.exe git status',
            'C:/Users/x/.local/bin/rtk.exe git status',
            './rtk git status', '/usr/local/bin/rtk git status',
            '"rtk" git status', "'rtk' git status",
            '"C:\\Program Files\\rtk\\rtk.exe" git status',
            'RTK_DISABLED=1 rtk git status',
            'FOO=bar BAZ=1 rtk git status',
            '  rtk git status',
            'rtk git status && rtk git log',
            'rtk ls; rtk grep x',
            'rtk git status | rtk grep foo',
            'rtk git status\nrtk git log',
            // 引号内的分隔符不能被当作段边界：否则 `rtk grep "foo;bar"` 会被切成
            // `rtk grep "foo` + `bar"`，第二段首词不是 rtk → 整条被误判为「非纯 rtk 调用」
            // （行为上只是多 spawn 一次 rtk，安全，但说明引号跟踪失效）
            'rtk grep "foo;bar"',
            "rtk grep 'a;b'",
            'rtk rg "x|y"',
            'rtk grep "a&&b"',
            'rtk git log --format="%h;%s"',
            'rtk grep "a;b" && rtk ls',
            'rtk git status && rtk grep "x;y"',
            'RTK grep "a;b"',
            'rtk.exe grep "a;b"',
            'rtk',
            'rtk.exe',
          ];
          for (const c of yes) check(G_E, `${name}(${JSON.stringify(c)}) === true`, fn(c) === true, `实际 ${JSON.stringify(fn(c))}`);

          // 关键反例：含非 rtk 段的复合命令**不能**被判为「纯 rtk 调用」，否则首段丢失改写
          const no = [
            'git status', 'ls -la', 'echo rtk', 'echo hi', '',
            'ls -la && rtk git status',
            'rtk git status && ls -la',
            'ls; rtk git status',
            'ls | rtk grep foo',
            'echo "rtk git status"',
            // 引号内出现 ; | && 后的切词必须正确：引号内的分隔符不能切断段
            'echo "a;b" && rtk git status',
            "echo 'x|y' ; rtk git status",
            'git log --format="a;b" && rtk ls',
            'echo "a&&b" && rtk git status',
            // 引号内的分隔符若被误当成分隔点，会切出一个假的「rtk 段」：
            //   `echo "a;rtk git status"` 若在引号内 ; 处切断，后半段首词就是 rtk → 误判为纯 rtk 调用
            'echo "x;rtk git status"',
            "echo 'x|rtk ls'",
            'git log --format="%h;rtk git status"',
            'echo "a&&rtk git status"',
            'printf "rtk git status"',
            'echo "rtk git status" && echo "rtk git log"',
          ];
          for (const c of no) check(G_E, `${name}(${JSON.stringify(c)}) === false`, fn(c) === false, `实际 ${JSON.stringify(fn(c))}`);

          // 冗余分隔符 / 尾随操作符：仍应判为纯 rtk 调用（空段不得破坏判定）
          const emptySegmentCases = [
            'rtk git status;;', 'rtk git status &&', 'rtk git status ||',
            '&& rtk git status', 'rtk git status && && rtk ls',
            'rtk git status\n\nrtk ls', 'rtk;rtk', 'rtk&&rtk',
            'rtk  git  status',
          ];
          for (const c of emptySegmentCases) {
            check(G_E, `${name}(${JSON.stringify(c)}) === true（空段/多余操作符不影响）`,
              fn(c) === true, `实际 ${JSON.stringify(fn(c))}`);
          }
        }
      }
    }

    // ─────────── F. 复合命令与管道（真 rtk 的 oracle） ───────────
    const G_F = 'F. 复合命令与管道（真 rtk）';
    if (FAST) {
      check(G_F, 'FAST 模式跳过真 rtk 组', true);
    } else if (!real.available) {
      check(G_F, '真实 rtk 可用', false, '未找到 rtk，跳过真 rtk 相关用例');
    } else {
      const { executor } = await loadExecutor(real.bin);
      const compounds = [
        'git status && git push',
        'ls; git status',
        'ls | grep foo',
        'ls > out.txt',
        'echo $(date)',
        'git status || git log',
        'echo hi && echo bye',
      ];
      for (const cmd of compounds) {
        const { code, out } = await realRewrite(real.bin, cmd);
        const expected = expectedCommandFor(cmd, code, out);
        const actual = await executedCommand(executor, { command: cmd });
        eq(G_F, `「${cmd}」→ 与 rtk(exit ${code}) 契约一致`, actual, expected,
          `rtk 输出 ${JSON.stringify(out)}`);
      }
      // `ls | grep foo` 的关键点：rtk 只改写管道后段（`ls | rtk grep foo`），插件整体透传结果即可
      {
        const { code, out } = await realRewrite(real.bin, 'ls | grep foo');
        check(G_F, '管道：rtk 只改写能识别的段，插件不改结构', code === 3 && out === 'ls | rtk grep foo',
          `rtk 实测 exit=${code} out=${JSON.stringify(out)}`);
      }
    }

    // ─────────── G. 命令族冒烟（真 rtk，核心诉求「适配所有命令」） ───────────
    const G_G = 'G. 命令族冒烟（真 rtk）';
    const FAMILIES = [
      ['cloud', ['aws s3 ls', 'docker ps', 'kubectl get pods', 'curl -I https://example.com']],
      ['dotnet', ['dotnet build', 'dotnet restore']],
      ['git', ['git status', 'git log --oneline', 'gh pr list', 'glab mr list']],
      ['go', ['go test ./...', 'go build', 'golangci-lint run']],
      ['js', ['npm run build', 'vitest run', 'tsc --noEmit', 'eslint .', 'prettier --check .', 'next build', 'npx jest']],
      ['jvm', ['mvn test', 'gradlew build']],
      ['php', ['php artisan list', 'phpunit', 'phpstan analyse', 'composer install']],
      ['python', ['pytest -q', 'ruff check', 'mypy .', 'pip install x', 'uv sync']],
      ['ruby', ['rspec', 'rake test', 'rubocop', 'bundle install']],
      ['rust', ['cargo test', 'cargo build', 'cargo clippy']],
      ['scala', ['sbt test', 'sbt compile']],
      ['system', ['ls -la', 'cat f.txt', 'head -5 f.txt', 'rg foo', 'find . -name x', 'tree', 'du -sh .']],
    ];
    const passthrough = ['echo hi', 'pwd', 'env', 'mkdir -p a', 'rm x', 'which node', 'whoami', 'Get-ChildItem', 'npm test', 'tail f.txt'];
    if (FAST) {
      check(G_G, 'FAST 模式跳过命令族冒烟', true);
    } else if (!real.available) {
      check(G_G, '真实 rtk 可用', false, '未找到 rtk，跳过命令族冒烟');
    } else {
      const { executor } = await loadExecutor(real.bin);
      for (const [family, cmds] of FAMILIES) {
        let rewritten = 0;
        for (const cmd of cmds) {
          const { code, out } = await realRewrite(real.bin, cmd);
          const expected = expectedCommandFor(cmd, code, out);
          const actual = await executedCommand(executor, { command: cmd });
          eq(G_G, `[${family}] ${cmd} → 契约一致`, actual, expected, `rtk exit=${code} out=${JSON.stringify(out)}`);
          if (actual !== cmd) rewritten += 1;
        }
        check(G_G, `[${family}] 至少一条真实命令被改写`, rewritten > 0, `${cmds.length} 条里改写了 ${rewritten} 条`);
      }
      for (const cmd of passthrough) {
        const { code, out } = await realRewrite(real.bin, cmd);
        if (code === 1) {
          eq(G_G, `[无等价] ${cmd} → 原样透传`, await executedCommand(executor, { command: cmd }), cmd);
        } else {
          const expected = expectedCommandFor(cmd, code, out);
          eq(G_G, `[无等价探测] ${cmd} → 契约一致`, await executedCommand(executor, { command: cmd }), expected);
        }
      }
    }

    // ─────────── H. 模块契约（导出、候选路径、peer 范围） ───────────
    const G_H = 'H. 模块契约';
    {
      const { mod } = await loadExecutor(FAKE_RTK_BIN);
      eq(G_H, 'default 导出是类', typeof mod.default, 'function');
      eq(G_H, 'dshPackageJsonCandidates 是函数', typeof mod.dshPackageJsonCandidates, 'function');

      const cands = mod.dshPackageJsonCandidates('E:\\Tool\\DSH');
      check(G_H, '候选路径含 node_modules/@deepseek-ai/dsh/package.json',
        cands.some((p) => p.includes('node_modules') && p.includes('@deepseek-ai') && p.endsWith('package.json')),
        JSON.stringify(cands));
      check(G_H, '候选路径含 POSIX lib/node_modules 布局', cands.some((p) => p.includes('lib') && p.includes('node_modules')), JSON.stringify(cands));
      check(G_H, '候选路径含 Electron app.asar 布局',
        cands.some((p) => p.includes('resources') && p.includes('app.asar') && p.includes('dsh')), JSON.stringify(cands));

      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      check(G_H, 'package.json 声明 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh));
      check(G_H, 'files 白名单包含 index.js 与 cordis.patch.yml',
        pkg.files.includes('index.js') && pkg.files.includes('cordis.patch.yml'), JSON.stringify(pkg.files));
      const peerRange = pkg.peerDependencies?.['@deepseek-ai/dsh-pwsh-sandbox'];
      check(G_H, 'peerDependencies 声明 dsh-pwsh-sandbox', typeof peerRange === 'string' && peerRange.length > 0, String(peerRange));
      if (peerRange) {
        check(G_H, 'peer 范围覆盖 0.2.1-rc.3（includePrerelease）', satisfies(peerRange, '0.2.1-rc.3', { includePrerelease: true }), peerRange);
        check(G_H, 'peer 范围覆盖 0.2.2-rc.1（includePrerelease）', satisfies(peerRange, '0.2.2-rc.1', { includePrerelease: true }), peerRange);
        check(G_H, 'peer 范围默认语义会漏判预发布（说明 includePrerelease 必需）',
          !satisfies(peerRange, '0.2.1-rc.3'), peerRange);
      }
      check(G_H, 'cordis.patch.yml 禁用原 pwsh-sandbox 行',
        readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8').includes('disabled: true'), '');
    }
  } finally {
    process.chdir(cwdBefore);
    teardownSandbox();
  }

  report(env);
}

// ────────────────────────────── 手写 semver（零依赖，够用即可） ──────────────────────────────

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) throw new Error(`invalid version: ${v}`);
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [] };
}
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; ; i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
    return x < y ? -1 : 1;
  }
}
function satisfies(range, version, { includePrerelease = false } = {}) {
  const target = parseSemver(version);
  return range.split('||').some((set) => {
    const comparators = set.trim().split(/\s+/).filter(Boolean).map((token) => {
      const m = /^(>=|<=|>|<)?(.+)$/.exec(token);
      return { op: m[1] || '=', v: parseSemver(m[2]) };
    });
    const matched = comparators.every(({ op, v }) => {
      const c = compareSemver(target, v);
      return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    });
    if (!matched) return false;
    if (includePrerelease || !target.pre.length) return true;
    return comparators.some(({ v }) => v.pre.length && v.core.join('.') === target.core.join('.'));
  });
}

// ────────────────────────────── 报告 ──────────────────────────────

function report(env) {
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  console.log('');
  console.log('══ rtk-rewrite 验证报告 ══════════════════════════════════════════');
  console.log(`目标模块: ${env.target}   模式:${env.mode}`);
  console.log(`环境: node ${env.node} / ${env.platform}-${env.arch} / rtk ${env.rtk.available ? env.rtk.version : '(未安装)'}`);
  console.log('');
  for (const [group, rows] of groups) {
    const pass = rows.filter((r) => r.ok).length;
    console.log(`── ${group}  [${pass}/${rows.length}]`);
    for (const r of rows) {
      if (r.ok) { console.log(`   ok   ${r.name}`); continue; }
      const tag = r.soft ? 'WARN' : 'FAIL';
      console.log(`   ${tag} ${r.name}${r.detail ? `\n          ↳ ${r.detail}` : ''}`);
    }
    console.log('');
  }

  const hardFail = results.filter((r) => !r.ok && !r.soft);
  const softWarn = results.filter((r) => !r.ok && r.soft);
  const passed = results.filter((r) => r.ok).length;

  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`总计 ${results.length} 项：通过 ${passed} / 失败 ${hardFail.length} / 与契约不一致 ${softWarn.length}`);
  if (softWarn.length) {
    console.log('');
    console.log('与上游契约不一致（非阻断，默认应 FAIL，SOFT=1 时降级）：');
    for (const r of softWarn) console.log(`  · [${r.group}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (hardFail.length) {
    console.log('');
    console.log('失败项：');
    for (const r of hardFail) console.log(`  · [${r.group}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    console.log('');
    console.log('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('RESULT: ALL PASS');
}

await main();
