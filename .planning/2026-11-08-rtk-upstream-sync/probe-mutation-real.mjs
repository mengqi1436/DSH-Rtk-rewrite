// 审查实验 14：对改造后的 index.js 做真实变异测试（用 test.js 自带的 RTK_TEST_TARGET）。
// 每个变异体写到临时副本，跑 test.js，看是否变红——这才是「测试能否捕获回归」的证据。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'rtkmut-real-'));

// 把仓库只读复制一份（index.js + test.js + package.json + cordis.patch.yml）
cpSync(path.join(REPO, 'test.js'), path.join(work, 'test.js'));
cpSync(path.join(REPO, 'package.json'), path.join(work, 'package.json'));
cpSync(path.join(REPO, 'cordis.patch.yml'), path.join(work, 'cordis.patch.yml'));

const MUTANTS = [
  {
    id: 'M1',
    desc: 'exit 2 分支删除（回到「exit 2 + stdout 就采纳」的旧错误）',
    from: `        } else if (Number(err.code) === 2) {
          // Deny rule matched. Anything on stdout is a pipeline-rule message,
          // never a command line, so it must not be handed to the shell.
        } else if (Number(err.code) === 3 && out) {`,
    to: `        } else if (Number(err.code) === 3 && out) {`,
  },
  {
    id: 'M2',
    desc: 'isRtkInvocation 恒假（递归防护完全失效）',
    from: '  return segments.length > 0 && segments.every(isRtkSegment);',
    to: '  return false;',
  },
  {
    id: 'M3',
    desc: 'isRtkInvocation 恒真（所有命令都不改写）',
    from: '  return segments.length > 0 && segments.every(isRtkSegment);',
    to: '  return true;',
  },
  {
    id: 'M4',
    desc: '幂等比较删除（rewritten !== command 去掉）',
    from: '    if (rewritten && rewritten !== spec.command) {',
    to: '    if (rewritten) {',
  },
  {
    id: 'M5',
    desc: '失败安全破坏（rewrite 失败后抛错而不是执行原命令）',
    from: `    return super.execute(spec);
  }
}`,
    to: `    throw new Error('MUTANT: blocked');
  }
}`,
  },
  {
    id: 'M6',
    desc: 'spec spread 丢字段（只传 command）',
    from: '      return super.execute({ ...spec, command: rewritten });',
    to: '      return super.execute({ command: rewritten });',
  },
  {
    id: 'M7',
    desc: '超时分支删除（killed 落到 else 的 warn + null，行为不变 ⇒ 应存活）',
    from: `        } else if (err.killed) {
          warn(\`rewrite timed out after \${REWRITE_TIMEOUT_MS}ms; running command unrewritten\`);`,
    to: `        } else if (false) {`,
  },
  {
    id: 'M8',
    desc: 'exit 1 分支删除（exit 1 落到 else 的 warn，功能不变但多一条噪声告警）',
    from: `        } else if (Number(err.code) === 1) {
          // No rewrite: silent pass-through.`,
    to: `        } else if (false) {`,
  },
  {
    id: 'M9',
    desc: 'trim 删除（stdout 带换行直接当命令）',
    from: "        const out = String(stdout || '').trim();",
    to: "        const out = String(stdout || '');",
  },
  {
    id: 'M10',
    desc: 'RTK_DISABLED 判断删除',
    from: "    if (process.env.RTK_DISABLED === '1') return super.execute(spec);",
    to: '    if (false) return super.execute(spec);',
  },
  {
    id: 'M11',
    desc: 'isRtkSegment 去掉 basename 归一（绝对路径不再识别）',
    from: "  const basename = word.split(/[\\\\/]/).pop();",
    to: "  const basename = word;",
  },
  {
    id: 'M12',
    desc: 'catche 分支删除（异常向上冒）',
    from: `    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }`,
    to: `    } catch (err) {
      log('swallowed', err && err.message);
    }`,
  },
];

const rows = [];
for (const m of MUTANTS) {
  const dir = path.join(work, m.id);
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(work, f), path.join(dir, f));
  const hit = src.includes(m.from);
  writeFileSync(path.join(dir, 'index.js'), hit ? src.replace(m.from, m.to) : src);
  let status = 'GREEN(存活)';
  let detail = '';
  try {
    const out = execFileSync(process.execPath, ['test.js'], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000,
      env: { ...process.env, RTK_TEST_TARGET: './index.js' },
    });
    const m2 = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(out);
    detail = m2 ? `pass=${m2[2]} fail=${m2[3]}` : out.split('\n').slice(-2).join(' ');
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 3);
    const m2 = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    status = 'RED(捕获)';
    detail = (m2 ? `pass=${m2[2]} fail=${m2[3]} | ` : '') + fails.join(' ‖ ').slice(0, 200);
  }
  rows.push({ id: m.id, desc: m.desc, hit, status, detail });
  console.log(`${m.id} hit=${hit} ${status}  ${m.desc}`);
  if (hit && detail) console.log(`     ${detail}`);
}

console.log('\n汇总：捕获 ' + rows.filter((r) => r.status.startsWith('RED')).length + ' / ' + rows.length);
console.log('存活（未被测试锁定）:');
for (const r of rows.filter((r) => r.status.startsWith('GREEN'))) console.log('  · ' + r.id + ' ' + r.desc);
console.log('\n工作目录: ' + work);
