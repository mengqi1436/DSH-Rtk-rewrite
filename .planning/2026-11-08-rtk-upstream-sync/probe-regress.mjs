// 审查实验 23（关键回归验证）：P0-1 与 P1-1 已在最新 index.js 修好，
// 但 test.js 是否锁定了这两个修法？做针对性回退变异。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'rtkregress-'));

function runMutant(id, from, to, desc) {
  const dir = path.join(work, id);
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  const hit = src.includes(from);
  writeFileSync(path.join(dir, 'index.js'), hit ? src.replace(from, to) : src);
  try {
    const o = execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000 });
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(o);
    console.log(`${id} hit=${hit} GREEN(未锁定)  ${desc}` + (m ? `  pass=${m[2]} fail=${m[3]}` : ''));
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 3);
    console.log(`${id} hit=${hit} RED(已锁定)   ${desc}` + (m ? `  pass=${m[2]} fail=${m[3]}` : '') + (fails.length ? `\n     ${fails.join(' ‖ ').slice(0, 200)}` : ''));
  }
}

console.log('## R1: 回退 P0-1 —— 把 super.execute 移回 try 内（恢复双执行缺陷）');
runMutant(
  'R1',
  `    let rewritten = null;
    try {
      rewritten = await rtkRewrite(spec.command);
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`,
  `    try {
      const rewritten = await rtkRewrite(spec.command);
      if (rewritten && rewritten !== spec.command) {
        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
        return super.execute({ ...spec, command: rewritten });
      }
    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`,
  'super.execute 回到 try 内（双执行 + 异常降级回归）',
);

console.log('\n## R2: 回退 P1-1 —— 去掉 `--` 隔离（恢复 help 文本当命令）');
runMutant(
  'R2',
  `      command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],`,
  `      ['rewrite', command],`,
  '去掉 leading-dash 的 -- 隔离',
);

console.log('\n## R3: 半修 —— 只把 `-h` 特判，其余 leading-dash 未隔离');
runMutant(
  'R3',
  `      command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],`,
  `      command === '-h' ? ['rewrite', '--', command] : ['rewrite', command],`,
  '仅特判 -h（--help 仍泄露 help 文本）',
);

console.log('\n## R4: 反向 —— 无条件加 --（验证是否误伤）');
runMutant(
  'R4',
  `      command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],`,
  `      ['rewrite', '--', command],`,
  '无条件加 --',
);

console.log('\n工作目录: ' + work);
