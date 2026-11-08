// 终审实验 10（决定性）：P0-1 的真实缺陷形态必须带 `await`。
// JS 语义：`try { return promise }` 捕获不到 rejection（return 立即完成）；
// 只有 `try { return await promise }` 才在 try 内 await，rejection 才会进 catch。
// 旧版 index.js（244 行）正是 `return await super.execute(...)`，所以 P0-1 真实成立。
// 本实验用带 await 的变异体复验 E0 组能否捕获。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const lines = readFileSync(path.join(REPO, 'index.js'), 'utf8').split('\n');
const work = mkdtempSync(path.join(tmpdir(), 'p01true-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

const bs = lines.findIndex((l, i) => i > 200 && l.trim() === 'let rewritten = null;');
const be = lines.findIndex((l, i) => i > bs && l.trim() === 'return super.execute(spec);');

// ★ 真实 P0-1 形态：if 块在 try 内 + `return await`
const P01_TRUE = [
  '    try {',
  '      const rewritten = await rtkRewrite(spec.command);',
  '      if (rewritten && rewritten !== spec.command) {',
  "        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));",
  '        return await super.execute({ ...spec, command: rewritten });',
  '      }',
  '    } catch (err) {',
  '      warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);',
  '    }',
  '    return super.execute(spec);',
];

// 对照 A：try 内但无 await（语义上等价于修好的版本 —— 验证"只去 await 也能修"）
const P01_NOAWAIT = P01_TRUE.map((l) => l.replace('return await super.execute', 'return super.execute'));

function build(variantLines, name) {
  const src = [...lines.slice(0, bs), ...variantLines, ...lines.slice(be + 1)].join('\n');
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'index.js'), src);
  return dir;
}

function run(dir, env, label) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['test.js'], { cwd: dir, timeout: 300000, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(out);
      const fails = out.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 6).map((l) => l.trim().slice(0, 118));
      const crashed = !m;
      resolve({ label, exit: err ? err.code : 0, stats: m ? `pass=${m[2]} fail=${m[3]}` : 'CRASH', fails, crashed, stderr: String(stderr || '').slice(0, 300) });
    });
  });
}

const CI = { ...process.env, RTK_TEST_FAST: '1', PATH: NO_RTK };
const FULL = { ...process.env };

const variants = [
  ['BASELINE', lines.slice(bs, be + 1), '当前正确版本'],
  ['P01-TRUE', P01_TRUE, '★ 真实 P0-1（try 内 + return await）'],
  ['P01-NOAWAIT', P01_NOAWAIT, '对照：try 内但无 await'],
];

for (const [name, vlines, desc] of variants) {
  const dir = build(vlines, name);
  for (const [envLabel, env] of [['CI(FAST+noRtk)', CI], ['FULL(local)', FULL]]) {
    const r = await run(dir, env, `${name}@${envLabel}`);
    console.log(`${name.padEnd(12)} [${envLabel.padEnd(14)}] exit=${r.exit} ${r.stats.padEnd(20)} ${desc}`);
    for (const f of r.fails) console.log('       ↳ ' + f);
    if (r.crashed && r.stderr) console.log('       ↳ stderr: ' + r.stderr.split('\n')[0].slice(0, 120));
  }
  console.log('');
}

rmSync(work, { recursive: true, force: true });
