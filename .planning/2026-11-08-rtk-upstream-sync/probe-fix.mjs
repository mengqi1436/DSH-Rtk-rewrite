// 审查实验 21：验证两个必须修问题的修法（在临时副本上改，不动仓库正文）。
// P0-1: catch 过宽 → 把 super.execute 挪出 try
// P1-1: clap 吃掉 `-`/`--` 开头命令 → 首字符为 `-` 时插 `--`
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'rtkfix-'));

// ── 修法定义 ──
// P0-1：try 只包 rtkRewrite；super.execute 移出
const P0_FROM = `    try {
      const rewritten = await rtkRewrite(spec.command);
      // rtk does not suppress identity rewrites, so this comparison is the
      // only thing standing between us and re-running the same command text.
      if (rewritten && rewritten !== spec.command) {
        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
        // Spread keeps workdir/timeoutMs/signal/stdin/env and the sandbox
        // policy fields resolve() stamped; only the command text changes.
        return await super.execute({ ...spec, command: rewritten });
      }
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }
    return super.execute(spec);`;
const P0_TO = `    // Only the rewrite itself is fail-open. super.execute() stays OUTSIDE this
    // try: a sandbox denial, runner failure or caller abort must reach the
    // caller unchanged, and the command must never run a second time.
    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }
    // rtk does not suppress identity rewrites, so this comparison is the
    // only thing standing between us and re-running the same command text.
    if (rewritten && rewritten !== spec.command) {
      log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
      // Spread keeps workdir/timeoutMs/signal/stdin/env and the sandbox
      // policy fields resolve() stamped; only the command text changes.
      return super.execute({ ...spec, command: rewritten });
    }
    return super.execute(spec);`;

// P1-1：首字符为 `-` 时插 `--`
const P1_FROM = `    execFile(
      RTK_BIN,
      ['rewrite', command],`;
const P1_TO = `    execFile(
      RTK_BIN,
      // A command whose first byte is '-' would be parsed by clap as one of
      // \`rtk rewrite\`'s own flags: \`-h\`/\`--help\` print the help text to stdout
      // and exit 0, which this function would then hand to the shell as the
      // command. \`--\` terminates option parsing so the text stays a command.
      command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],`;

// 版本 A：只修 P0
// 版本 B：只修 P1
// 版本 C：两个都修
const variants = {
  'P0-only': [[P0_FROM, P0_TO]],
  'P1-only': [[P1_FROM, P1_TO]],
  'both': [[P0_FROM, P0_TO], [P1_FROM, P1_TO]],
};

const OUT = [];
for (const [name, transforms] of Object.entries(variants)) {
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  let out = src;
  let allHit = true;
  for (const [from, to] of transforms) {
    if (!out.includes(from)) { allHit = false; break; }
    out = out.replace(from, to);
  }
  writeFileSync(path.join(dir, 'index.js'), out);
  try {
    const o = execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000 });
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(o);
    OUT.push(`${name}: hit=${allHit} 现有套件 GREEN  pass=${m?.[2]} fail=${m?.[3]}`);
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 4);
    OUT.push(`${name}: hit=${allHit} 现有套件 RED  pass=${m?.[2]} fail=${m?.[3]}\n     ${fails.join(' ‖ ').slice(0, 260)}`);
  }
}
console.log(OUT.join('\n'));

// 行为验证：both 版本是否真的修好了两个问题
console.log('\n## 行为验证（both 版本）');
const dir = path.join(work, 'both');
const FAKE_DSH = path.join(work, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  async execute(spec) {
    globalThis.__calls = globalThis.__calls || [];
    globalThis.__calls.push(String(spec.command));
    if (globalThis.__FAIL && String(spec.command).startsWith('rtk ')) {
      const e = new Error('SANDBOX_UNAVAILABLE: runner failed'); e.name = 'SandboxUnavailableError'; throw e;
    }
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

// P0 验证：沙箱异常是否上抛、命令是否只执行一次
globalThis.__FAIL = true; globalThis.__calls = [];
let thrown = null;
try { await ex.execute({ command: 'git status' }); } catch (e) { thrown = e; }
console.log('  P0 沙箱异常: 调用序列=' + JSON.stringify(globalThis.__calls) + ' 抛出=' + (thrown ? thrown.name : 'none'));
globalThis.__FAIL = false;

// P1 验证：-h / --help 是否还泄露 help 文本
for (const c of ['-h', '--help', '-hh']) {
  globalThis.__calls = [];
  await ex.execute({ command: c });
  const v = String(globalThis.__calls.at(-1) ?? '');
  console.log('  P1 ' + JSON.stringify(c).padEnd(10) + ' 最终执行=' + JSON.stringify(v.slice(0, 40)) + ' 是help文本=' + /Usage:|Exit codes/.test(v));
}
// 回归：正常命令是否仍改写
for (const c of ['git status', 'ls -la', 'Get-ChildItem']) {
  globalThis.__calls = [];
  await ex.execute({ command: c });
  console.log('  回归 ' + JSON.stringify(c).padEnd(16) + ' -> ' + JSON.stringify(globalThis.__calls.at(-1)));
}

console.log('\n工作目录: ' + work);
