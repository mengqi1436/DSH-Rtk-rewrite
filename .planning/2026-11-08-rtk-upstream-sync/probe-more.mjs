// 审查实验 15：补齐 M12 真正的变异（删掉 catch）+ 验证修法可行性 + 性能开销。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const src = readFileSync(path.join(REPO, 'index.js'), 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'rtkmut2x-'));
for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(REPO, f), path.join(work, f));

// M13：整个 try/catch 删掉，只留 rtkRewrite 调用（异常直接向上冒）
const M13_FROM = `    try {
      const rewritten = await rtkRewrite(spec.command);`;
const M13_TO = `    {
      const rewritten = await rtkRewrite(spec.command);`;
const M14_FROM = `    } catch (err) {
      warn(\`rewrite failed (\${err?.message ?? err}); running command unrewritten\`);
    }
    return super.execute(spec);`;
const M14_TO = `    }
    return super.execute(spec);`;

function runMutant(id, transforms, desc) {
  const dir = path.join(work, id);
  mkdirSync(dir, { recursive: true });
  for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) cpSync(path.join(work, f), path.join(dir, f));
  let out = src;
  let hit = true;
  for (const [from, to] of transforms) {
    if (!out.includes(from)) { hit = false; break; }
    out = out.replace(from, to);
  }
  writeFileSync(path.join(dir, 'index.js'), out);
  try {
    const o = execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000 });
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(o);
    console.log(`${id} hit=${hit} GREEN(存活)  ${desc}` + (m ? `  pass=${m[2]} fail=${m[3]}` : ''));
    return 'survived';
  } catch (e) {
    const all = String(e.stdout || '') + '\n' + String(e.stderr || '');
    const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
    const fails = all.split('\n').filter((l) => /^\s+(FAIL|WARN)\s/.test(l)).slice(0, 2);
    console.log(`${id} hit=${hit} RED(捕获)   ${desc}` + (m ? `  pass=${m[2]} fail=${m[3]}` : '') + (fails.length ? `\n     ${fails.join(' ‖ ').slice(0, 160)}` : ''));
    return 'caught';
  }
}

console.log('## 补齐变异');
runMutant('M13', [[M13_FROM, M13_TO]], '删掉 try 包裹（rtkRewrite 异常向上冒）');
runMutant('M14', [[M14_FROM, M14_TO]], '删掉 catch（异常直接向上冒）');
runMutant('M15', [[`    if (isRtkInvocation(spec.command)) return super.execute(spec);`, `    if (false) return super.execute(spec);`]], '递归防护整行删除');
runMutant('M16', [[`        if (err.code === 'ENOENT') {`, `        if (false) {`]], 'ENOENT 单次告警逻辑删除');
runMutant('M17', [[`      { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },`, `      { windowsHide: true },`]], '去掉 rtk 调用 timeout（无超时兜底）');

// 性能：rtkRewrite 单次开销
console.log('\n## 性能开销实测（真实 rtk）');
function timeRtk(cmd) {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    execFile('rtk', ['rewrite', cmd], { timeout: 10000, windowsHide: true }, () => {
      resolve(Number(process.hrtime.bigint() - t0) / 1e6);
    });
  });
}
const samples = [];
for (let i = 0; i < 20; i++) samples.push(await timeRtk('git status'));
samples.sort((a, b) => a - b);
console.log('  rtk rewrite 单次: min=' + samples[0].toFixed(1) + 'ms median=' + samples[10].toFixed(1) + 'ms p90=' + samples[18].toFixed(1) + 'ms max=' + samples[19].toFixed(1) + 'ms');

// 并发：10 个同时 rewrite
console.log('\n## 并发 10 路 rewrite');
const t0 = process.hrtime.bigint();
await Promise.all(Array.from({ length: 10 }, () => timeRtk('git status')));
console.log('  并发 10 路总耗时: ' + (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) + 'ms');

// 修法验证：rtk rewrite 是否接受 `--` 分隔
console.log('\n## 修法验证：`rtk rewrite -- <cmd>` 是否可用');
function raw(args) {
  return new Promise((resolve) => {
    execFile('rtk', args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: String(stdout || '').slice(0, 90) });
    });
  });
}
for (const args of [
  ['rewrite', '--', '-h'],
  ['rewrite', '--', '--help'],
  ['rewrite', '--', 'git status'],
  ['rewrite', '--', '--version'],
  ['rewrite', '-h'],
]) {
  console.log('  ' + JSON.stringify(args).padEnd(34) + ' -> ' + JSON.stringify(await raw(args)));
}

console.log('\n工作目录: ' + work);
