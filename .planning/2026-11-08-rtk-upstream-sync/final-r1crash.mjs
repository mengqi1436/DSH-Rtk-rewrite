// 终审实验 4：R1 在 CI 环境到底是「断言失败」还是「崩溃」？崩溃是门禁有效还是掩盖了问题？
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'final-r1crash-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

const R1_FROM = `    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`;
const R1_TO = `    try {
      const rewritten = await rtkRewrite(spec.command);
      if (rewritten && rewritten !== spec.command) {
        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
        return super.execute({ ...spec, command: rewritten });
      }
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`;

function runShell(dir, env, label) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['test.js'], { cwd: dir, timeout: 300000, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ label, exitCode: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// 变异副本
const mdir = path.join(work, 'R1');
mkdirSync(mdir, { recursive: true });
for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(mdir, f));
writeFileSync(path.join(mdir, 'index.js'), src.includes(R1_FROM) ? src.replace(R1_FROM, R1_TO) : src);

// 基线副本
const bdir = path.join(work, 'BASE');
mkdirSync(bdir, { recursive: true });
for (const f of ['index.js', 'test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(bdir, f));

const CI_ENV = { ...process.env, RTK_TEST_FAST: '1', PATH: NO_RTK };

const base = await runShell(bdir, CI_ENV, 'BASE[CI]');
console.log('## 基线（未变异，CI 环境）');
console.log('  exit=' + base.exitCode + '  含统计行=' + /总计 \d+ 项/.test(base.stdout));

const r1ci = await runShell(mdir, CI_ENV, 'R1[CI]');
console.log('\n## R1（变异，CI 环境）');
console.log('  exit=' + r1ci.exitCode);
console.log('  含统计行=' + /总计 \d+ 项/.test(r1ci.stdout));
const r1Fails = r1ci.stdout.split('\n').filter((l) => /FAIL|WARN/.test(l));
console.log('  FAIL/WARN 行数=' + r1Fails.length);
for (const l of r1Fails.slice(0, 8)) console.log('    ' + l.trim().slice(0, 120));
const errLines = (r1ci.stderr || '').split('\n').filter(Boolean).slice(0, 12);
if (errLines.length) {
  console.log('  stderr 前几行：');
  for (const l of errLines) console.log('    ' + l.slice(0, 140));
}
// 最后 12 行 stdout
console.log('  stdout 末尾：');
for (const l of r1ci.stdout.trim().split('\n').slice(-12)) console.log('    ' + l.slice(0, 140));

const r1full = await runShell(mdir, { ...process.env }, 'R1[FULL]');
console.log('\n## R1（变异，FULL 环境）');
console.log('  exit=' + r1full.exitCode + '  含统计行=' + /总计 \d+ 项/.test(r1full.stdout));
const f2 = r1full.stdout.split('\n').filter((l) => /FAIL/.test(l));
for (const l of f2.slice(0, 6)) console.log('    ' + l.trim().slice(0, 120));

rmSync(work, { recursive: true, force: true });
