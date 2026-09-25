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
 *  - Failure safety: any rewrite failure (rtk missing, exit 1 = no equivalent,
 *    timeout) runs the original command unrewritten. Execution is never
 *    blocked or denied by this plugin.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

// The dsh-shipped packages are not published at matching versions on npm
// (registry @deepseek-ai/dsh is 0.1.5-rc.3; this machine runs 0.1.7-rc.2), so
// the bundle declares no npm dependency and resolves them from the dsh
// installation instead. If dsh moves or upgrades to a new install location,
// update this constant.
const DSH_INSTALL_PACKAGE_JSON =
  'E:/Tool/nvm/v24.19.0/node_modules/@deepseek-ai/dsh/package.json';

const { SandboxPwshExecutor } = createRequire(DSH_INSTALL_PACKAGE_JSON)(
  '@deepseek-ai/dsh-pwsh-sandbox',
);

const REWRITE_TIMEOUT_MS = 5000;
const RTK_BIN = process.env.RTK_BIN || 'rtk';
const log = (...parts) => console.log('[rtk-rewrite]', ...parts);
const warn = (...parts) => console.warn('[rtk-rewrite]', ...parts);

let missingWarned = false;

/**
 * Ask rtk for the rewritten form of `command`.
 * Resolves the rewritten command string, or null when the command must run
 * unrewritten (no equivalent / rtk unavailable / timeout / any failure).
 *
 * Observed exit-code behavior (rtk 0.50.0 on Windows, differs from --help
 * which documents "exits 0"): a supported command — including one already in
 * rtk form — exits 3 with the command on stdout; no equivalent exits 1 with
 * no output. Node v24's execFile surfaces the child's exit code on err.code
 * (a number, e.g. 3) with err.exitCode undefined; spawn failures like
 * ENOENT put a string on err.code. Hence the Number(err.code) checks.
 */
function rtkRewrite(command) {
  return new Promise((resolve) => {
    execFile(
      RTK_BIN,
      ['rewrite', command],
      { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (!err) {
          resolve(out || null);
          return;
        }
        if (err.code === 'ENOENT') {
          if (!missingWarned) {
            missingWarned = true;
            warn(`'${RTK_BIN}' not found on PATH; commands run unrewritten`);
          }
        } else if (err.killed) {
          warn(`rewrite timed out after ${REWRITE_TIMEOUT_MS}ms; running command unrewritten`);
        } else if (Number(err.code) === 1) {
          // rtk's documented "no equivalent" exit: silent pass-through.
        } else if (out) {
          // e.g. exit 3: rtk printed the (possibly identity) rewritten form.
          resolve(out);
          return;
        } else {
          warn(`rewrite exited ${err.code ?? 'unknown'} with no output; running command unrewritten`);
        }
        resolve(null);
      },
    );
  });
}

export default class RtkPwshExecutor extends SandboxPwshExecutor {
  async execute(spec) {
    // rtk's own single-command opt-out: RTK_DISABLED=1 skips rewriting.
    if (process.env.RTK_DISABLED === '1') return super.execute(spec);
    // Never rewrite an rtk invocation (recursion guard).
    const trimmed = spec.command.trimStart();
    if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) {
      return super.execute(spec);
    }
    try {
      const rewritten = await rtkRewrite(spec.command);
      if (rewritten && rewritten !== spec.command) {
        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
        // Spread keeps workdir/timeoutMs/signal/stdin/env and the sandbox
        // policy fields resolve() stamped; only the command text changes.
        return await super.execute({ ...spec, command: rewritten });
      }
    } catch (err) {
      warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);
    }
    return super.execute(spec);
  }
}
