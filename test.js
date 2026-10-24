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

// 最小 semver 范围匹配：只覆盖 peer 范围用到的 ||、空格分隔的 >=/<=/>/</= 比较子
// 与预发布优先级比较（够用即可，完整 semver 由 DSH 侧的 semver 提供）。
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) throw new Error(`invalid version: ${v}`);
  return {
    core: [+m[1], +m[2], +m[3]],
    pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; ; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1; // 数字标识符优先级更低
    return x < y ? -1 : 1;
  }
}

function satisfies(range, version, { includePrerelease = false } = {}) {
  const target = parseSemver(version);
  return range.split('||').some((set) => {
    const comparators = set.trim().split(/\s+/).filter(Boolean).map((token) => {
      const m = /^(>=|<=|>|<)?(.+)$/.exec(token);
      return { op: m[1] || '=', v: parseSemver(m[2]) };
    });
    const matched = comparators.every(({ op, v }) => {
      const c = compareSemver(target, v);
      return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    });
    if (!matched) return false;
    // semver 预发布语义：默认只有同一 core 且带预发布的比较子才放行预发布目标版本；
    // includePrerelease 关闭该限制。
    if (includePrerelease || !target.pre.length) return true;
    return comparators.some(({ v }) => v.pre.length && v.core.join('.') === target.core.join('.'));
  });
}

// 1. 有等价 → 返回改写结果
assert((await rtkRewrite('git status')) === 'rtk git status', 'git status -> rtk git status');
// 2. 无等价 → null
assert((await rtkRewrite('Get-ChildItem')) === null, 'Get-ChildItem -> null (exit 1)');
// 3. 已是 rtk 形式 → 输出原样（execute 层的 rewritten !== command 会跳过替换）
assert((await rtkRewrite('rtk git status')) === 'rtk git status', 'rtk git status -> identity');
// 4. 模块本身可加载且导出类
const mod = await import('./index.js');
assert(typeof mod.default === 'function', 'index.js default export is a class');
// 5. 桌面 Electron 布局探测链：拼接规则正确 + 本机真实桌面端（若可读）命中 asar 内内核包
//    asar 内文件只有 Electron 主进程（fs 已 patch）能读；裸 node 下跳过真实命中检查。
const { dshPackageJsonCandidates } = mod;
const cands = dshPackageJsonCandidates('E:\\Tool\\DSH');
assert(
  cands.some((p) => p.includes('resources') && p.includes('app.asar') && p.includes('dsh')),
  'desktop layout candidate contains resources/app.asar/dsh',
);
const real = dshPackageJsonCandidates('E:\\Tool\\DSH').find((p) => p.includes('app.asar'));
if ((await import('node:fs')).existsSync(real)) {
  assert(dshPackageJsonCandidates('E:\\Tool\\DSH').includes(real), 'real desktop install resolves asar kernel package.json');
} else {
  console.log('skip: real desktop asar check needs the Electron main process (bare node cannot read asar)');
}
// 6. peer 范围在 DSH 的判定语义下覆盖当前内核 0.2.1-rc.3
//    DSH 插件兼容判定用 semver.satisfies(peerRange, version, {includePrerelease:true})。
const { readFileSync } = await import('node:fs');
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const peerRange = pkg.peerDependencies['@deepseek-ai/dsh-pwsh-sandbox'];
assert(
  satisfies(peerRange, '0.2.1-rc.3', { includePrerelease: true }),
  'peer range covers kernel 0.2.1-rc.3 under includePrerelease',
);
// 反向验证 includePrerelease 这个选项确实是必需的（默认 semver 语义会漏判预发布）。
assert(
  !satisfies(peerRange, '0.2.1-rc.3'),
  'peer range needs includePrerelease for 0.2.1-rc.3 (default semver would miss it)',
);
console.log('ALL PASS');
