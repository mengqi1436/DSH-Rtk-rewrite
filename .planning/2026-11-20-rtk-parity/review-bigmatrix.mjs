import { execFileSync } from 'node:child_process';
import { isRtkInvocation } from '../../index.js';

const SP = ' ', TAB = String.fromCharCode(9), LF = String.fromCharCode(10), CR = String.fromCharCode(13);
const NBSP = String.fromCharCode(160), IDSP = String.fromCharCode(12288);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const CASES = [];
const push = (c) => CASES.push(c);

// 1) rtk 词干变体 × 分隔符 × 前缀空白
const STEMS = ['rtk', 'rtk.exe', 'RTK', 'Rtk', 'RTK.EXE', './rtk', '../bin/rtk', '/usr/local/bin/rtk',
  'C:/Users/x/.local/bin/rtk.exe', '"rtk"', "'rtk'", '"C:/Users/x/rtk.exe"'];
const SEP = ['', ' ', '  ', TAB, LF, CR + LF, ' ; ', ' && ', ' || ', ' & ', ' | '];
for (const stem of STEMS) {
  for (const sep of ['', ' ', TAB]) {
    for (const tail of ['', 'git status', 'ls -la', 'git status && rtk ls', 'ls | rtk grep x']) {
      const core = stem + sep + tail;
      push(core);
      push(SP + core);
      push(core + SP);
      push(TAB + core + TAB);
      push(SP + SP + core + SP);
    }
  }
}
// 2) env 前缀链
for (const pre of ['FOO=1', 'RTK_DISABLED=1', 'A=1 B=2', 'FOO="a b"', 'rtk=1', 'RTK=1']) {
  push(pre + ' rtk git status'); push(pre + ' ls'); push(pre + '  rtk ls');
}
// 3) 透明前缀（§⑤/§⑦.1）
for (const w of ['uv run', 'timeout 30', 'time', 'nice', 'nice -n 5', 'noglob', 'command', 'builtin', 'exec', 'nocorrect', 'sudo', 'env']) {
  push(w + ' rtk git status'); push(w + ' git status'); push(w + ' rtk'); push(SP + w + ' rtk ls');
}
// 4) 空白特殊字符
for (const ws of [SP, TAB, LF, CR, CR + LF, NBSP, IDSP]) {
  push(ws + 'rtk git status'); push('rtk git status' + ws); push(ws + 'rtk' + ws);
}
// 5) 中间段空白
push('rtk git status' + LF + '  rtk ls');
push('rtk git status' + LF + TAB + 'rtk ls');
push('rtk git status &&   rtk ls');
push('rtk git status;' + LF + 'rtk ls');
push('rtk ls |   rtk grep x');
push('rtk git status' + CR + LF + 'rtk ls');
// 6) 拒绝改写的形态（§⑥）
for (const c of ['{ rtk git status; }', '( rtk ls )', 'if true; then rtk ls; fi', 'rtk git status > f',
  '$(rtk git status)', 'rtk git status 2>&1', 'for f in *; do rtk ls; done', 'cat -v f.txt']) push(c);
// 7) 非 rtk 对照
for (const c of ['git status', 'ls -la', 'echo rtk', 'echo "rtk git status"', 'rtk-helper x', 'rtkx y', '', '   ']) push(c);

function rtk(cmd) {
  try { return { code: 0, out: execFileSync('rtk', ['rewrite', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout || '').trim() }; }
}

const rows = [];
for (const c of CASES) {
  const skip = isRtkInvocation(c);
  const r = rtk(c);
  const wouldRewrite = (r.code === 0 || r.code === 3) && r.out !== '' && r.out !== c;
  const realDiv = skip && wouldRewrite && norm(r.out) !== norm(c);
  rows.push({ cmd: c, skip, code: r.code, out: r.out, wouldRewrite, realDiv });
}
const skipped = rows.filter(r => r.skip);
const realDiv = rows.filter(r => r.realDiv);
const formatOnly = skipped.filter(r => r.out && r.out !== r.cmd && norm(r.out) === norm(r.cmd));
console.log('总用例', rows.length, '| 插件跳过', skipped.length, '| 真实漏改写', realDiv.length, '| 仅排版差异', formatOnly.length);
console.log('--- 真实漏改写明细 ---');
for (const r of realDiv) console.log(JSON.stringify(r));
console.log('--- 仅排版差异（rtk 回吐去空白形态）---');
for (const r of formatOnly) console.log('  exit=' + r.code, JSON.stringify(r.cmd), '->', JSON.stringify(r.out));
console.log('--- 插件不跳过但 rtk 有实质改写（安全，多一次 spawn）---');
const extra = rows.filter(r => !r.skip && r.wouldRewrite && norm(r.out) !== norm(r.cmd));
console.log('  计数', extra.length);
