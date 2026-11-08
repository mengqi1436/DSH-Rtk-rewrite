// 审查实验 7：index.js 关键失败路径的实证（复制 index.js 的 execute 逻辑，注入可控 fake super）。
// 目的：证明 spec.command 非字符串、超长命令、maxBuffer 截断三条路径的真实后果。

const REWRITE_TIMEOUT_MS = 5000;
const RTK_BIN = 'rtk';

import { execFile } from 'node:child_process';

function rtkRewrite(command) {
  return new Promise((resolve) => {
    execFile(
      RTK_BIN,
      ['rewrite', command],
      { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (!err) { resolve(out || null); return; }
        if (err.code === 'ENOENT') { /* warn */ }
        else if (err.killed) { /* warn */ }
        else if (Number(err.code) === 1) { /* silent */ }
        else if (out) { resolve(out); return; }
        else { /* warn */ }
        resolve(null);
      },
    );
  });
}

class FakeSuper {
  constructor() { this.calls = []; }
  async execute(spec) { this.calls.push(spec.command); return { exitCode: 0, ran: spec.command }; }
}

function makeExecutor(sup) {
  return {
    async execute(spec) {
      if (process.env.RTK_DISABLED === '1') return sup.execute(spec);
      const trimmed = spec.command.trimStart();
      if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) return sup.execute(spec);
      try {
        const rewritten = await rtkRewrite(spec.command);
        if (rewritten && rewritten !== spec.command) {
          JSON.stringify(spec.command); JSON.stringify(rewritten);
          return await sup.execute({ ...spec, command: rewritten });
        }
      } catch (err) {
        console.log('   [warn] rewrite failed (' + (err && err.message) + ')');
      }
      return sup.execute(spec);
    },
  };
}

async function trial(label, spec) {
  const sup = new FakeSuper();
  const ex = makeExecutor(sup);
  let err = null;
  try {
    await ex.execute(spec);
  } catch (e) {
    err = e;
  }
  console.log(
    label.padEnd(34) + ' -> threw=' + (err ? err.constructor.name + ':' + String(err.message).slice(0, 60) : 'no') +
      ' ran=' + JSON.stringify(sup.calls.map((c) => (c && c.length > 40 ? c.slice(0, 40) + '…(' + c.length + ')' : c))),
  );
}

await trial('E1 command=undefined', { command: undefined });
await trial('E2 command=null', { command: null });
await trial('E3 command=number', { command: 42 });
await trial('E4 200KB 命令', { command: 'x'.repeat(200 * 1024) });
await trial('E5 32KB 命令', { command: 'git status ' + 'x'.repeat(32 * 1024) });
await trial('E6 空串', { command: '' });
await trial('E7 空白串', { command: '   ' });
await trial('E8 含 NUL', { command: 'git status\u0000--x' });
await trial('E9 正常命令', { command: 'git status' });
