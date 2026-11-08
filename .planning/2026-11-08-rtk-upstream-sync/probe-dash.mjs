// 审查实验 13：以 `-` 开头的命令被 clap 当作 flag 时，插件是否会拿 help/version 文本当命令执行（P0 候选）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'D:\\Code\\DSH-Rtk-rewrite';
const TMP = mkdtempSync(path.join(tmpdir(), 'rtkrev13-'));
const FAKE_DSH = path.join(TMP, 'dsh');
mkdirSync(path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0' }));
const pkgDir = path.join(FAKE_DSH, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox');
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.1-rc.3', main: 'index.cjs' }));
writeFileSync(path.join(pkgDir, 'index.cjs'), `'use strict';
class SandboxPwshExecutor {
  async execute(spec) {
    globalThis.__specs = globalThis.__specs || [];
    globalThis.__specs.push({ command: spec.command });
    return { executed: spec.command };
  }
}
module.exports = { SandboxPwshExecutor };
`);
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(FAKE_DSH, 'package.json');
process.env.RTK_BIN = 'rtk';
const mod = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?t=' + Date.now());
const ex = new mod.default({});

const CASES = ['-h', '--help', '-v', '--version', '--', '-x ls', 'pwsh -h', 'git -h'];
console.log('## 以 - 开头的命令：rtk 被 clap 解析成 flag 时的插件行为');
for (const c of CASES) {
  globalThis.__specs = [];
  let thrown = null;
  try { await ex.execute({ command: c }); } catch (e) { thrown = e; }
  const finalCmd = globalThis.__specs.at(-1)?.command;
  const isHelpText = typeof finalCmd === 'string' && /Rewrite a raw command|Usage:|Options:/i.test(finalCmd);
  console.log(
    '  ' + JSON.stringify(c).padEnd(14) +
      ' 最终执行=' + JSON.stringify(String(finalCmd ?? '').slice(0, 70)).padEnd(74) +
      (isHelpText ? '  << 把 HELP 文本当成命令执行了！' : '') +
      (thrown ? ' THROWN=' + thrown.message.slice(0, 40) : ''),
  );
}

rmSync(TMP, { recursive: true, force: true });
