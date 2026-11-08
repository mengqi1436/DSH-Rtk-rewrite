// 终审实验 2：P0-1 的回退变异 R1 在 FAST+noRtk（CI）环境下是否也变红。
// 若只有本地 FULL 才红，说明 CI 上 P0-1 无覆盖 —— 那是更严重的门禁缺口。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'final-r1-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

// R1：把 super.execute 移回 try 内，恢复双执行 + 异常降级
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

function runVariant(id, from, to, env, desc) {
  const dir = path.join(work, id + (env.fast ? '-fast' : '-full') + (env.noRtk ? '-nortk' : ''));
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  const hit = src.includes(from);
  writeFileSync(path.join(dir, 'index.js'), hit ? src.replace(from, to) : src);
  const childEnv = { ...process.env };
  if (env.fast) childEnv.RTK_TEST_FAST = '1';
  if (env.noRtk) childEnv.PATH = env.noRtk;
  let status;
  let tail = '';
  try {
    const o = execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000, env: childEnv });
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(o);
    status = 'GREEN(未锁定)';
    tail = m ? `pass=${m[2]} fail=${m[3]}` : '';
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 4);
    status = 'RED(已锁定)';
    tail = (m ? `pass=${m[2]} fail=${m[3]} | ` : '') + fails.join(' ‖ ').slice(0, 220);
  }
  console.log(`${id} [${env.fast ? 'FAST' : 'FULL'}${env.noRtk ? '+noRtk' : ''}] hit=${hit} ${status}  ${desc}`);
  if (tail) console.log(`     ${tail}`);
}

console.log('## R1：super.execute 移回 try（恢复 P0-1 双执行 + 异常降级）');
runVariant('R1', R1_FROM, R1_TO, { fast: true, noRtk: NO_RTK }, '★ FAST + 无 rtk（= CI 环境）');
runVariant('R1', R1_FROM, R1_TO, {}, 'FULL + 有 rtk（本地）');

console.log('\n## 逐条拆解 E0 组在 FAST+noRtk 下是否真的在跑');
// 直接从 CI 日志确认 E0 组项数
const E0_DIR = path.join(work, 'E0-check');
mkdirSync(E0_DIR, { recursive: true });
for (const f of ['index.js', 'test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(E0_DIR, f));
try {
  const o = execFileSync(process.execPath, ['test.js'], {
    cwd: E0_DIR, encoding: 'utf8', stdio: 'pipe', timeout: 300000,
    env: { ...process.env, RTK_TEST_FAST: '1', PATH: NO_RTK },
  });
  const line = o.split('\n').filter((l) => /^── E0/.test(l)).join('\n');
  console.log('  ' + line);
} catch (e) {
  console.log('  基线下 E0 组执行异常：' + String(e.message).slice(0, 100));
}

rmSync(work, { recursive: true, force: true });
