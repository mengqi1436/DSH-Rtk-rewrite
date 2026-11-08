// 终审实验 3：R1 在 CI 环境的失败形态（断言失败 vs 崩溃）+ 任务3 的等价变异体复核。
// 任务3 重点：test-engineer 声称 30 个变异体 = 28 捕获 + 2 等价（M25 while/filter 冗余、M27 Number() 防御性）。
// 逐一验证这两个"等价"论证是否成立。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const testSrc = readFileSync(path.join(REPO, 'test.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'final-eq-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

function run(id, transforms, label) {
  const dir = path.join(work, id);
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  let out = src;
  let hit = true;
  for (const [from, to] of transforms) {
    if (!out.includes(from)) { hit = false; console.log(`  !! ${id} 变异点未命中: ${JSON.stringify(from.slice(0, 70))}`); break; }
    out = out.replace(from, to);
  }
  writeFileSync(path.join(dir, 'index.js'), out);
  let status; let detail = '';
  try {
    const o = execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000 });
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(o);
    status = 'GREEN';
    detail = m ? `pass=${m[2]} fail=${m[3]}` : o.trim().split('\n').slice(-3).join(' | ');
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 3);
    const crash = /TypeError|Error:|at file:/.test(all) && !m;
    status = crash ? 'CRASH' : 'RED';
    detail = (m ? `pass=${m[2]} fail=${m[3]} | ` : '崩溃式退出 | ') + fails.join(' ‖ ').slice(0, 200);
  }
  console.log(`  ${status.padEnd(6)} hit=${hit}  ${label}`);
  if (detail) console.log(`         ${detail}`);
  return status;
}

console.log('══ 任务1 补充：R1 在 CI 环境的失败形态 ══');
{
  const dir = path.join(work, 'R1-ci');
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  const from = `    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`;
  const to = `    try {
      const rewritten = await rtkRewrite(spec.command);
      if (rewritten && rewritten !== spec.command) {
        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
        return super.execute({ ...spec, command: rewritten });
      }
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`;
  writeFileSync(path.join(dir, 'index.js'), src.includes(from) ? src.replace(from, to) : src);
  try {
    execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000, env: { ...process.env, RTK_TEST_FAST: '1', PATH: NO_RTK } });
    console.log('  R1[CI] GREEN —— 未锁定！');
  } catch (e) {
    const all = String(e.stdout || '') + String(e.stderr || '');
    const fails = all.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 6);
    const hasStat = /总计 \d+ 项/.test(all);
    console.log(`  R1[CI] 非零退出；含统计行=${hasStat}`);
    console.log('  失败项：');
    for (const f of fails) console.log('    ' + f.trim().slice(0, 110));
  }
}

console.log('\n══ 任务3：两个"等价变异体"的论证复核 ══');

// M25 声称：while 的 '&|' 跳过是冗余的（因为 filter 会丢掉空段）
console.log('\n[M25] while (i+1 < len && "&|".includes(cmd[i+1])) i++;  —— 声称与删除等价');
run('M25-del-while', [[
  `      while (i + 1 < command.length && '&|'.includes(command[i + 1])) i++;`,
  ``,
]], '删掉 while 跳过循环');
run('M25-noop', [], '基线对照（不变异）');

// M27 声称：Number(err.code) 是防御性代码（err.code 恒为数字或字符串 ENOENT）
console.log('\n[M27] Number(err.code) === N —— 声称去掉 Number() 等价');
for (const n of ['1', '2', '3']) {
  run(`M27-${n}`, [[
    `} else if (Number(err.code) === ${n}${n === '3' ? ' && out' : ''}) {`,
    `} else if (err.code === ${n}${n === '3' ? ' && out' : ''}) {`,
  ]], `Number(err.code) === ${n} → err.code === ${n}`);
}

console.log('\n══ 额外：直接验证 err.code 的实际类型 ══');
{
  // 用真 rtk 和假 rtk 各跑一次，打印 err.code 的 typeof
  const probe = path.join(work, 'code-type.mjs');
  writeFileSync(probe, `
import { execFile } from 'node:child_process';
function run(bin, args) {
  return new Promise((r) => execFile(bin, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
    r({ code: err ? err.code : 0, codeType: err ? typeof err.code : 'no-error', killed: err ? !!err.killed : false, out: String(stdout||'').slice(0,30) });
  }));
}
console.log('真 rtk git status  →', JSON.stringify(await run('rtk', ['rewrite', 'git status'])));
console.log('真 rtk Get-ChildItem →', JSON.stringify(await run('rtk', ['rewrite', 'Get-ChildItem'])));
console.log('不存在 bin         →', JSON.stringify(await run('definitely-not-rtk-xyz', ['rewrite', 'x'])));
console.log('真 rtk --version   →', JSON.stringify(await run('rtk', ['--version'])));
`);
  try {
    const o = execFileSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60000 });
    console.log(o.trim().split('\n').map((l) => '  ' + l).join('\n'));
  } catch (e) { console.log('  探测失败: ' + String(e.message).slice(0, 100)); }
}

rmSync(work, { recursive: true, force: true });
