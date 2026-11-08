// 终审实验 1（最关键）：R2 回退变异（去掉 `--` 隔离）在 FAST + 无 rtk 环境下是否仍变红。
// 若这里 GREEN，说明 CI 上 P1-1 无覆盖 —— 假 rtk 锁不住。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'final-r2-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

function runVariant(id, transforms, env, desc) {
  const dir = path.join(work, id + '-' + (env.RTK_TEST_FAST ? 'fast' : 'full') + (env.noRtk ? '-nortk' : ''));
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  let out = src;
  let hit = true;
  for (const [from, to] of transforms) {
    if (!out.includes(from)) { hit = false; break; }
    out = out.replace(from, to);
  }
  writeFileSync(path.join(dir, 'index.js'), out);

  const childEnv = { ...process.env };
  if (env.RTK_TEST_FAST) childEnv.RTK_TEST_FAST = '1';
  if (env.noRtk) childEnv.PATH = env.noRtk;   // 只剩空的 nortk 目录

  let status;
  let tail = '';
  try {
    const o = execFileSync(process.execPath, ['test.js'], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000, env: childEnv,
    });
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(o);
    status = 'GREEN';
    tail = m ? `pass=${m[2]} fail=${m[3]}` : o.split('\n').slice(-2).join(' ');
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 4);
    status = 'RED';
    tail = (m ? `pass=${m[2]} fail=${m[3]} | ` : '') + fails.join(' ‖ ').slice(0, 240);
  }
  console.log(`${id} [${env.RTK_TEST_FAST ? 'FAST' : 'FULL'}${env.noRtk ? '+noRtk' : ''}] hit=${hit} ${status}  ${desc}`);
  if (tail) console.log(`     ${tail}`);
  return status;
}

const R2 = [[
  `      command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],`,
  `      ['rewrite', command],`,
]];
const R3 = [[
  `      command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],`,
  `      command === '-h' ? ['rewrite', '--', command] : ['rewrite', command],`,
]];
const NONE = [];

console.log('## 基线（未变异）');
runVariant('BASE', NONE, { RTK_TEST_FAST: '1', noRtk: NO_RTK }, 'FAST + 无 rtk（= CI 环境）');

console.log('\n## R2：去掉 -- 隔离（恢复 P1-1）');
runVariant('R2', R2, { RTK_TEST_FAST: '1', noRtk: NO_RTK }, '★ FAST + 无 rtk（CI 环境）');
runVariant('R2', R2, {}, 'FULL + 有 rtk（本地环境）');

console.log('\n## R3：半修，只特判 -h（--help 仍泄露）');
runVariant('R3', R3, { RTK_TEST_FAST: '1', noRtk: NO_RTK }, '★ FAST + 无 rtk（CI 环境）');
runVariant('R3', R3, {}, 'FULL + 有 rtk（本地环境）');

console.log('\n## 结论判据');
console.log('  R2/R3 在 FAST+noRtk 下必须 RED，否则 CI 上 P1-1 无覆盖。');

rmSync(work, { recursive: true, force: true });
