/**
 * 最小自检：node test.js
 * 覆盖 rtkRewrite 判定逻辑（从 index.js 抽取同一规则做行为验证）与模块加载。
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const REWRITE_TIMEOUT_MS = 5000;
const RTK_BIN = process.env.RTK_BIN || 'rtk';
let missingWarned = false;

// 与 index.js 中 rtkRewrite 完全一致的判定规则（复制以独立运行）
function rtkRewrite(command) {
  return new Promise((resolve) => {
    execFile(
      RTK_BIN,
      ['rewrite', command],
      { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (!err) { resolve(out || null); return; }
        if (err.code === 'ENOENT') {
          if (!missingWarned) { missingWarned = true; console.warn('[rtk-rewrite] not on PATH'); }
        } else if (err.killed) {
          console.warn('[rtk-rewrite] timeout');
        } else if (Number(err.code) === 1) {
          // 无等价：静默
        } else if (out) {
          resolve(out); return;
        } else {
          console.warn(`[rtk-rewrite] exit ${err.code} no output`);
        }
        resolve(null);
      },
    );
  });
}

const assert = (cond, name) => {
  if (!cond) { console.error(`FAIL: ${name}`); process.exit(1); }
  console.log(`ok: ${name}`);
};

// 1. 有等价 → 返回改写结果
assert((await rtkRewrite('git status')) === 'rtk git status', 'git status -> rtk git status');
// 2. 无等价 → null
assert((await rtkRewrite('Get-ChildItem')) === null, 'Get-ChildItem -> null (exit 1)');
// 3. 已是 rtk 形式 → 输出原样（execute 层的 rewritten !== command 会跳过替换）
assert((await rtkRewrite('rtk git status')) === 'rtk git status', 'rtk git status -> identity');
// 4. 模块本身可加载且导出类
const mod = await import('./index.js');
assert(typeof mod.default === 'function', 'index.js default export is a class');
// 5. 桌面 Electron 布局探测链：拼接规则正确 + 本机真实桌面端（若安装）命中 asar 内内核包
const { dshPackageJsonCandidates } = mod;
const cands = dshPackageJsonCandidates('E:\\Tool\\DSH');
assert(
  cands.some((p) => p.includes('resources') && p.includes('app.asar') && p.includes('dsh')),
  'desktop layout candidate contains resources/app.asar/dsh',
);
const realDesktop = 'E:\\Tool\\DSH\\DeepSeek Harness.exe';
if (await import('node:fs').then((fs) => fs.existsSync(realDesktop))) {
  const real = dshPackageJsonCandidates('E:\\Tool\\DSH').find((p) => p.includes('app.asar'));
  assert(real && (await import('node:fs')).existsSync(real), 'real desktop install resolves asar kernel package.json');
}
console.log('ALL PASS');
