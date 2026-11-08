// 终审实验 5（自我纠错）：上一版 R1 变异体是坏的 —— 它把 rewritten 弄出了作用域，
// 触发 ReferenceError 而不是复现 P0-1 的真实缺陷（super.execute 在 try 内 → 异常被吞 + 双执行）。
// 这里重建语义正确的 R1：保留 let rewritten 在外层，只把 super.execute 移回 try 内。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'final-r1fix-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

// 当前正确代码（index.js:247-261）
const CUR = `    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }
    // rtk does not suppress identity rewrites, so this comparison is the only
    // thing standing between us and re-running the same command text.
    if (rewritten && rewritten !== spec.command) {
      log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
      // Spread keeps workdir/timeoutMs/signal/stdin/env and the sandbox
      // policy fields resolve() stamped; only the command text changes.
      return super.execute({ ...spec, command: rewritten });
    }
    return super.execute(spec);`;

// P0-1 的真实缺陷形态：super.execute 在 try 内，rewritten 仍在外层作用域
const P01 = `    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
      if (rewritten && rewritten !== spec.command) {
        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
        return super.execute({ ...spec, command: rewritten });
      }
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }
    return super.execute(spec);`;

function run(label, code, env) {
  const dir = path.join(work, label.replace(/[^\w]/g, '_'));
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'index.js'), code);
  return new Promise((resolve) => {
    execFile(process.execPath, ['test.js'], { cwd: dir, timeout: 300000, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout || '');
      const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(out);
      const fails = out.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 5).map((l) => l.trim().slice(0, 110));
      const crashed = !m;
      resolve({ exitCode: err ? err.code : 0, stats: m ? `pass=${m[2]} fail=${m[3]}` : '无统计行(崩溃)', fails, crashed });
    });
  });
}

const CI = { ...process.env, RTK_TEST_FAST: '1', PATH: NO_RTK };
const FULL = { ...process.env };

console.log('## 变异点命中检查');
console.log('  当前代码块在 index.js 中：' + src.includes(CUR));
if (!src.includes(CUR)) { console.log('  !! 无法构造变异，退出'); process.exit(1); }
const baseline = src;
const mutant = src.replace(CUR, P01);

for (const [envLabel, env] of [['CI (FAST+noRtk)', CI], ['FULL (local)', FULL]]) {
  const b = await run('BASE-' + envLabel, baseline, env);
  const m = await run('P01-' + envLabel, mutant, env);
  console.log('\n## ' + envLabel);
  console.log('  基线  exit=' + b.exitCode + '  ' + b.stats);
  console.log('  P0-1变异 exit=' + m.exitCode + '  ' + m.stats + '  崩溃=' + m.crashed);
  for (const f of m.fails) console.log('    ' + f);
}

rmSync(work, { recursive: true, force: true });
