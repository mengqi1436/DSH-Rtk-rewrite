import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/Code/DSH-Rtk-rewrite';
const src = readFileSync(ROOT + '/index.js', 'utf8');
const marker = 'if (/^[\\s\\u0085]|[\\s\\u0085]$/.test(text)) return false;';
const hit = src.includes(marker);
console.log('marker hit =', hit);
if (!hit) {
  const idx = src.indexOf('test(text)) return false;');
  console.log('fallback ctx:', JSON.stringify(src.slice(idx - 60, idx + 30)));
  process.exit(2);
}
const dir = ROOT + '/.mychk4/nel';
rmSync(ROOT + '/.mychk4', { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const f of ['test.js', 'package.json', 'cordis.patch.yml']) copyFileSync(ROOT + '/' + f, dir + '/' + f);
writeFileSync(dir + '/index.js', src.replace(marker, 'if (text !== text.trim()) return false;'));
try {
  const out = execFileSync(process.execPath, ['test.js'], {
    cwd: dir, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, RTK_TEST_FAST: '1', RTK_TEST_TARGET: './index.js' },
  });
  const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(out);
  console.log('存活(未被捕获):', m ? m[0] : out.split('\n').slice(-2).join(' '));
} catch (e) {
  const all = String(e.stdout || '') + String(e.stderr || '');
  const m = /总计 (\d+) 项：通过 (\d+) \/ 失败 (\d+)/.exec(all);
  const fails = all.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3);
  console.log('捕获:', m ? m[0] : '', '|', fails.join(' ‖ ').slice(0, 300));
}
