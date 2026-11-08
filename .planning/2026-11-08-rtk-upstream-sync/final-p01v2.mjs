// 终审实验 7：定位上一版变异的真实问题 —— CUR 切片边界取错（indexOf 命中了 RTK_DISABLED 那一行）。
// 用行号精确切片重建变异体，并 dump 变异后的 execute() 全文核对。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const lines = readFileSync(path.join(REPO, 'index.js'), 'utf8').split('\n');

// 按行号精确定位 execute 方法体（从 'async execute(spec)' 到类的结束 '}'）
const startIdx = lines.findIndex((l) => l.includes('async execute(spec) {'));
let endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');   // 类体结束
console.log('## execute 方法行范围: ' + (startIdx + 1) + ' .. ' + (endIdx + 1));
console.log('原文:');
for (let i = startIdx; i <= endIdx; i++) console.log(String(i + 1).padStart(4) + ' | ' + lines[i]);

// 构造 P0-1 变异：把 try 的范围扩大到包住 if 块与第一个 return
const blockStart = lines.findIndex((l, i) => i > startIdx && l.trim() === 'let rewritten = null;');
const blockEnd = lines.findIndex((l, i) => i > blockStart && l.trim() === 'return super.execute(spec);');
console.log('\n## 待替换块行范围: ' + (blockStart + 1) + ' .. ' + (blockEnd + 1));

const P01 = [
  '    let rewritten = null;',
  '    try {',
  '      rewritten = await rtkRewrite(spec.command);',
  '      if (rewritten && rewritten !== spec.command) {',
  "        log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));",
  '        return super.execute({ ...spec, command: rewritten });',
  '      }',
  '    } catch (err) {',
  '      warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);',
  '    }',
  '    return super.execute(spec);',
];

const mutantLines = [...lines.slice(0, blockStart), ...P01, ...lines.slice(blockEnd + 1)];
const mutant = mutantLines.join('\n');

console.log('\n## 变异后的 execute()');
const ms = mutantLines.findIndex((l) => l.includes('async execute(spec) {'));
const me = mutantLines.findIndex((l, i) => i > ms && l === '}');
for (let i = ms; i <= me; i++) console.log(String(i + 1).padStart(4) + ' | ' + mutantLines[i]);

const work = mkdtempSync(path.join(tmpdir(), 'p01v2-'));
const NO_RTK = path.join(work, 'nortk');
mkdirSync(NO_RTK, { recursive: true });

function run(label, code, env) {
  const dir = path.join(work, label.replace(/[^\w]/g, '_'));
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'index.js'), code);
  return new Promise((resolve) => {
    execFile(process.execPath, ['test.js'], { cwd: dir, timeout: 300000, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout || '');
      const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(out);
      const fails = out.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 6).map((l) => l.trim().slice(0, 120));
      resolve({ exit: err ? err.code : 0, stats: m ? `pass=${m[2]} fail=${m[3]}` : 'CRASH(无统计行)', fails });
    });
  });
}

console.log('\n## 精确变异体的检测结果');
const baseline = lines.join('\n');
for (const [envLabel, env] of [
  ['CI(FAST+noRtk)', { ...process.env, RTK_TEST_FAST: '1', PATH: NO_RTK }],
  ['FULL(local)', { ...process.env }],
]) {
  const b = await run('BASE-' + envLabel, baseline, env);
  const m = await run('P01-' + envLabel, mutant, env);
  console.log(`  ${envLabel}`);
  console.log(`    基线   exit=${b.exit} ${b.stats}`);
  console.log(`    P0-1   exit=${m.exit} ${m.stats}`);
  for (const f of m.fails) console.log('      ↳ ' + f);
}

rmSync(work, { recursive: true, force: true });
