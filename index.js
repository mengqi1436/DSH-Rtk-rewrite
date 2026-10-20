/**
 * DSH native rtk bridge — a `ctx.shell` provider that transparently rewrites
 * every shell command through `rtk rewrite "<cmd>"` before execution.
 *
 * Design (per the deepseek-harness official plugin model):
 *  - `SandboxPwshExecutor` (@deepseek-ai/dsh-pwsh-sandbox) already owns the
 *    full local pwsh + sandbox-confinement pipeline: resolve() stamps the
 *    per-call sandbox policy, execute() wraps the pwsh argv via ctx.sandbox.
 *  - We subclass it and only intercept execute(): rewrite spec.command first,
 *    then hand the rewritten spec to super.execute(), so confinement wraps the
 *    rewritten command and all sandbox facts/accounting stay intact.
 *  - The UTF-8 output preamble is prepended at the spawnSpec layer inside
 *    PwshLocalExecutor (lib/index.js), so spec.command seen here is the raw
 *    command — safe to feed to `rtk rewrite` directly.
 *  - 失败语义按 rtk 1.0.1 的四档退出码区分：0/3 = 用改写结果执行；1 = 无改写，
 *    原样执行；2 = deny 命中，命令绝不执行，直接合成一个失败结果返回
 *    （fail-closed）；ENOENT / 超时 / 其它异常仍 fail-open（原样执行 + warn）。
 *  - 能力探测：首次改写前用 `<bin> rewrite --help` 探测一次（成功永久缓存，失败按
 *    PROBE_TTL_MS 后重试）。不支持 `rewrite` 子命令的 rtk（< 1.0，或 RTK_BIN 指到
 *    别的 CLI）整体降级为 pass-through——不 rewrite、不 deny，绝不能因为外部二进制
 *    的版本问题把 DSH 的 shell 变成全拒绝。
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';

const CORE_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox';

/**
 * Resolve the dsh-shipped `@deepseek-ai/dsh-pwsh-sandbox` from the running
 * dsh installation. The npm registry copy of this package often lags (or
 * diverges from) the copy shipped inside the running host (it sat at
 * 0.1.5-rc.3 for a long stretch; 0.2.0 resumed publishing but the desktop
 * bundle may still assemble a different rev), so the bundle declares the
 * core package as a peerDependency (for the market's host-aware discovery)
 * but loads the copy shipped inside the dsh install itself.
 *
 * Resolution order:
 *  1. `DSH_INSTALL_PACKAGE_JSON` env var — explicit override, path to the
 *     dsh installation's package.json
 *  2. Normal node resolution from this module (works when npm links the
 *     peer to a matching-version host)
 *  3. `<node install>/node_modules/@deepseek-ai/dsh` (Windows layout:
 *     E:\Tool\nvm\v24\node.exe → E:\Tool\nvm\v24\node_modules\...)
 *  4. `<node install>/../lib/node_modules/@deepseek-ai/dsh` (POSIX nvm
 *     layout: ~/.nvm/versions/node/v24/bin/node → .../lib/node_modules/...)
 *  5. `<exe dir>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`
 *     (Electron desktop layout: DeepSeek Harness.exe → the kernel packaged
 *     inside app.asar; readable because the desktop main process patches fs
 *     for asar, and this module runs inside that process)
 */
export function dshPackageJsonCandidates(nodeDir) {
  return [
    path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(nodeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    // Electron desktop app layout (DeepSeek Harness.exe ships the kernel in
    // resources/app.asar; see dsh-desktop-host's own cli.js bootstrap path).
    path.join(nodeDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ];
}

function resolveDshPackageJson() {
  if (process.env.DSH_INSTALL_PACKAGE_JSON) return process.env.DSH_INSTALL_PACKAGE_JSON;
  try {
    return createRequire(import.meta.url).resolve(`${CORE_PACKAGE}/package.json`);
  } catch { /* not on the normal resolution chain */ }
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
  } catch { /* dsh itself not installed as a dependency */ }
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of dshPackageJsonCandidates(nodeDir)) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* unreadable path */ }
  }
  throw new Error(
    `Cannot resolve the dsh core package "${CORE_PACKAGE}". ` +
    `Set DSH_INSTALL_PACKAGE_JSON to the package.json of your dsh installation ` +
    `(e.g. <node dir>/node_modules/@deepseek-ai/dsh/package.json).`,
  );
}

const { SandboxPwshExecutor } = createRequire(resolveDshPackageJson())(CORE_PACKAGE);

const REWRITE_TIMEOUT_MS = 5000;
const log = (...parts) => console.log('[rtk-rewrite]', ...parts);
const warn = (...parts) => console.warn('[rtk-rewrite]', ...parts);

let missingWarned = false;

/** 调用期可覆盖的 rtk 启动参数（测试/包装器注入用，生产路径为空）。 */
let rtkLaunchOptions = {};

/** 能力探测结果：`{ capable, checkedAt }`，null = 尚未探测。 */
let capability = null;
let incapableWarned = false;
/** 不支持 `rewrite` 时多久后重探一次（用户可能中途升级 rtk）。 */
const PROBE_TTL_MS = 60_000;

/**
 * 覆盖 rtk 的启动参数：`bin` 为可执行文件，`prefix` 为插在 `rewrite` 之前的 argv。
 * 未显式注入时按调用期环境变量 RTK_BIN 解析（缺省 'rtk'）。
 * 换 bin 后必须重探能力，否则旧结果会把新二进制误判为支持/不支持。
 */
export function configureRtk(options) {
  rtkLaunchOptions = options ?? {};
  capability = null;
  incapableWarned = false;
}

function rtkLaunch() {
  const { prefix = [], ...rest } = rtkLaunchOptions;
  return { bin: rest.bin || process.env.RTK_BIN || 'rtk', prefix };
}

/** deny 结果哨兵：与原样执行（null）和改写结果（string）区分开。 */
export function isRtkDeny(value) {
  return typeof value === 'object' && value !== null && value.denied === true;
}

/**
 * 探测 rtk 是否支持 `rewrite` 子命令（rtk >= 1.0）。只看"子命令是否存在"这个
 * 确定性信号——`<bin> rewrite --help` 退出 0 即支持；ENOENT / 非 0（含 clap 的
 * `unrecognized subcommand`）/ 超时都按不支持处理。
 *
 * 不解析 stderr 文本：rtk 的 deny 与 clap 的用法错误同为 exit 2，靠文本启发式
 * 区分既脆弱又会漏判，所以降级判定完全不经过 rtkRewrite 的四档逻辑。
 *
 * 缓存策略：支持则永久缓存（零后续开销）；不支持则只在 PROBE_TTL_MS 后重试，
 * 避免每条命令都白跑一次探测，同时留出"用户中途升级 rtk"的恢复路径。
 */
async function rtkSupportsRewrite() {
  if (capability !== null) {
    if (capability.capable) return true;
    if (Date.now() - capability.checkedAt < PROBE_TTL_MS) return false;
  }
  const { bin, prefix } = rtkLaunch();
  const capable = await new Promise((resolve) => {
    execFile(
      bin,
      [...prefix, 'rewrite', '--help'],
      { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(err == null),
    );
  });
  capability = { capable, checkedAt: Date.now() };
  if (!capable && !incapableWarned) {
    incapableWarned = true;
    warn(`'${bin}' does not support 'rewrite' (needs rtk >= 1.0); commands run unrewritten`);
  }
  return capable;
}

/**
 * 询问 rtk 命令的改写形式。四档退出码见 `rtk rewrite --help`（rtk 1.0.1）：
 *   0 = 已打印改写且 allow 规则全覆盖 → 用改写结果
 *   1 = 无输出、无改写 → null（原样执行）
 *   2 = deny 命中 → { denied: true, message }，调用方必须阻止执行；
 *       无输出 = 规则 deny（交给宿主自己的 deny），有输出 = pipeline 规则消息
 *   3 = 已打印改写、待宿主审批 → 用改写结果（本插件无处审批，按改写执行）
 * 其余（ENOENT / 超时 / 未知退出码）保持 fail-open：null + warn。
 *
 * Node v24 的 execFile 把子进程退出码放在 err.code（数字），ENOENT 等 spawn
 * 失败把字符串放在 err.code，故用 Number(err.code) 判定。
 */
export function rtkRewrite(command, options = {}) {
  const { bin, prefix } = { ...rtkLaunch(), ...options };
  return new Promise((resolve) => {
    execFile(
      bin,
      [...(prefix ?? []), 'rewrite', command],
      { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!err) {
          // exit 0：改写结果；无输出时按"无改写"处理。
          resolve(out || null);
          return;
        }
        if (err.code === 'ENOENT') {
          if (!missingWarned) {
            missingWarned = true;
            warn(`'${bin}' not found on PATH; commands run unrewritten`);
          }
          resolve(null);
          return;
        }
        if (err.killed) {
          warn(`rewrite timed out after ${REWRITE_TIMEOUT_MS}ms; running command unrewritten`);
          resolve(null);
          return;
        }
        const exit = Number(err.code);
        if (exit === 2) {
          // deny 命中：必须排在"有输出即改写"之前，否则 deny 会被当成改写放行。
          // rtk 1.0.1 的 deny 出口是 exit(2) 且不打印任何内容；stderr 里只有每次调用都会
          // 出现的 hook 噪声（`[rtk] No hook installed…`），回落到 stderr 会让用户把噪声
          // 当成拒绝理由。因此只取 stdout，并滤掉 `[rtk] ` 前缀行（给将来版本的 deny
          // 消息留口）；过滤后为空则交给 deniedExecution() 的默认文案兜底。
          const reason = out
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('[rtk] '))
            .join('\n')
            .trim();
          resolve({ denied: true, message: reason });
          return;
        }
        if (exit === 1) {
          // 无改写：静默原样执行。
          resolve(null);
          return;
        }
        if (out) {
          // exit 3（待宿主审批）及其它带输出的退出码：用改写结果。
          resolve(out);
          return;
        }
        warn(`rewrite exited ${err.code ?? 'unknown'} with no output; running command unrewritten`);
        resolve(null);
      },
    );
  });
}

/** 被 deny 的命令没有真实退出码，沿用 rtk 的 deny 码 2 表示"未执行即失败"。 */
const DENY_EXIT_CODE = 2;

/**
 * 合成"命令未执行"的失败结果（ShellExecution 形状，见 dsh-shell/lib/types.d.ts）。
 * 被 deny 时绝不落到 super.execute()，因此没有真实进程：这里返回一个
 * 已完成状态、stderr 携带拒绝理由的 handle，调用方拿到的是失败而非空白。
 */
function deniedExecution(spec, message) {
  const text = message
    ? `rtk denied this command; it was not executed.\n${message}`
    : 'rtk denied this command; it was not executed.';
  const note = Buffer.from(text, 'utf8');
  const stdout = { text: '', truncated: false };
  const stderr = { text, truncated: false };
  const emptyReader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) };
  const stderrReader = {
    readFrom: (fromByte) => ({
      text: note.subarray(Math.max(0, Math.min(fromByte, note.length))).toString('utf8'),
      nextOffset: note.length,
      lossy: false,
    }),
  };
  // 沙箱本身没有拒绝任何文件操作，denied 保持 false；拒绝来自 rtk 规则。
  const sandbox = spec.sandboxPolicy?.mode === undefined
    ? undefined
    : { mode: spec.sandboxPolicy.mode, denied: false };
  const result = {
    exitCode: DENY_EXIT_CODE,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: spec.timeoutMs,
    stdout,
    stderr,
    ...(sandbox === undefined ? {} : { sandbox }),
  };
  let drained = false;
  let settled;
  return {
    status: 'completed',
    exitCode: DENY_EXIT_CODE,
    signal: null,
    sandbox,
    // 进程从未存在：done 已了结，kill 无事可做，readOutput 只吐出一次拒绝说明。
    done: Promise.resolve(),
    observed: { stdout: emptyReader, stderr: stderrReader },
    readOutput: () => {
      if (drained) return { delta: '', lossy: false };
      drained = true;
      return { delta: `[stderr]\n${text}`, lossy: false };
    },
    kill: () => false,
    result: () => (settled ??= Promise.resolve(result)),
  };
}

export default class RtkPwshExecutor extends SandboxPwshExecutor {
  async execute(spec) {
    // rtk's own single-command opt-out: RTK_DISABLED=1 skips rewriting (deny included).
    if (process.env.RTK_DISABLED === '1') return super.execute(spec);
    // Never rewrite an rtk invocation (recursion guard).
    const trimmed = spec.command.trimStart();
    if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) {
      return super.execute(spec);
    }
    // 能力探测：不支持 `rewrite` 的 rtk（< 1.0，或 RTK_BIN 指到别的 CLI）整体降级为
    // pass-through。必须在 deny 之前判掉——否则 clap 的"未知子命令"exit 2 会被当成
    // deny，让整个 shell 对这类用户不可用。
    if (!(await rtkSupportsRewrite())) return super.execute(spec);
    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
    } catch (err) {
      warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);
    }
    // deny 命中（唯一的 fail-closed 分支）：在 try 之外，任何异常都不会把它降级成放行。
    if (isRtkDeny(rewritten)) {
      warn(`${JSON.stringify(spec.command)} denied by rtk${rewritten.message ? `: ${rewritten.message}` : ''}`);
      return deniedExecution(spec, rewritten.message);
    }
    if (rewritten && rewritten !== spec.command) {
      log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
      // Spread keeps workdir/timeoutMs/signal/stdin/env and the sandbox
      // policy fields resolve() stamped; only the command text changes.
      // 注意：super.execute 抛出的错误直接向上抛给宿主工具层（由它渲染 spawn 失败），
      // 不要在这里 catch 后重跑原命令——那会把用户的命令重复执行一次。
      return await super.execute({ ...spec, command: rewritten });
    }
    return super.execute(spec);
  }
}
