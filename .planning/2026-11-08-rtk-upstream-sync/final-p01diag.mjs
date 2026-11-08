// 终审实验 6（深入）：为什么语义正确的 P0-1 变异体仍是 GREEN？
// 直接检查变异文件内容 + 单独跑 E0 组，定位 E0 为何没捕获。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'p01diag-'));

const CUR = src.slice(src.indexOf('    let rewritten = null;'), src.indexOf('    return super.execute(spec);') + '    return super.execute(spec);'.length);
console.log('## 当前代码块（从 let rewritten 到两处 return）');
console.log(CUR.split('\n').map((l) => '  | ' + l).join('\n'));

// 精确构造 P0-1：只把「if 块 + 两个 return」改成「if 块在 try 内 + 一个兜底 return」
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

const mutant = src.replace(CUR, P01);
console.log('\n## 替换是否生效：' + (mutant !== src));
console.log('  变异后含 "return super.execute({ ...spec, command: rewritten });" 的行：');
for (const [i, l] of mutant.split('\n').entries()) {
  if (l.includes('super.execute')) console.log(`    ${i + 1}: ${l.trim()}`);
}

const dir = path.join(work, 'mut');
mkdirSync(dir, { recursive: true });
for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(dir, f));
writeFileSync(path.join(dir, 'index.js'), mutant);

// 确认写入的确实是变异版
const written = readFileSync(path.join(dir, 'index.js'), 'utf8');
console.log('\n## 写入文件含变异特征（if 在 try 内）：' +
  written.includes(`      rewritten = await rtkRewrite(spec.command);
      if (rewritten && rewritten !== spec.command) {`));

// 只跑 E0 组：用 RTK_TEST_ONLY_GROUP 不存在，所以直接看 E0 组输出
function run(env, cb) {
  execFile(process.execPath, ['test.js'], { cwd: dir, timeout: 300000, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => cb(String(stdout || ''), err));
}

run({ ...process.env }, (out) => {
  console.log('\n## 变异体 FULL 环境下 E0 组明细');
  const lines = out.split('\n');
  const start = lines.findIndex((l) => /^── E0/.test(l));
  if (start === -1) { console.log('  未找到 E0 组！'); }
  else {
    for (let i = start; i < start + 18 && i < lines.length; i++) console.log('  ' + lines[i]);
  }
  const e0line = lines.find((l) => /^── E0/.test(l));
  console.log('\n  E0 汇总行: ' + e0line);

  // 关键：检查 setFailMode 是否真的生效
  console.log('\n## 检查 test.js 里 setFailMode 的定义与使用');
  const t = readFileSync(path.join(REPO, 'test.js'), 'utf8');
  const idx = t.indexOf('function setFailMode');
  if (idx === -1) console.log('  未找到 setFailMode 函数定义！');
  else console.log(t.slice(idx, idx + 300));

  rmSync(work, { recursive: true, force: true });
});
