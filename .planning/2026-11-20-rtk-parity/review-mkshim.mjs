import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const base = path.resolve('.planning/2026-11-20-rtk-parity/fakedsh');
mkdirSync(path.join(base, 'node_modules/@deepseek-ai/dsh-pwsh-sandbox'), { recursive: true });
writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'fakedsh', version: '0.0.0' }));
const pkg = path.join(base, 'node_modules/@deepseek-ai/dsh-pwsh-sandbox');
writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pwsh-sandbox', version: '0.2.2-rc.5', main: 'index.cjs' }));
writeFileSync(path.join(pkg, 'index.cjs'), [
  "class SandboxPwshExecutor {",
  "  constructor() {}",
  "  resolve(s) { return s; }",
  "  async execute(spec) { globalThis.__rtkSpecs = globalThis.__rtkSpecs || []; globalThis.__rtkSpecs.push(spec); return { executed: spec.command }; }",
  "}",
  "module.exports = { SandboxPwshExecutor };",
].join('\n'));
// 假 rtk：node <dir>/rewrite ...
const bin = path.resolve('.planning/2026-11-20-rtk-parity/fakebin');
mkdirSync(bin, { recursive: true });
writeFileSync(path.join(bin, 'rewrite'), [
  "'use strict';",
  "const a = process.argv.slice(2);",
  "const cmd = a[0] === '--' ? a[1] : a[0];",
  "process.stdout.write(cmd);",
  "process.exit(3);",
].join('\n'));
console.log('shim ok');