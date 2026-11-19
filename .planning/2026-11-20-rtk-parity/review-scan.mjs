import { readFileSync } from 'node:fs';
const s = readFileSync('test.js', 'utf8');
const lines = s.split('\n');
// 1) 打印 100-110 行的字符级信息
for (let i = 99; i < 110; i++) {
  const raw = lines[i] ?? '';
  const ticks = (raw.match(/`/g) || []).length;
  console.log(String(i + 1).padStart(4), 'ticks=' + ticks, JSON.stringify(raw));
}
// 2) 简单扫描：从第 81 行 writeFileSync 的模板字符串开始，找未转义反引号
const startLine = 80; // 0-based 81
let inTpl = false, tplStart = 0, bad = [];
for (let i = startLine; i < lines.length && i < 130; i++) {
  const raw = lines[i];
  for (let j = 0; j < raw.length; j++) {
    if (raw[j] === '\\') { j++; continue; }
    if (raw[j] === '`') {
      if (!inTpl) { inTpl = true; tplStart = i + 1; }
      else { inTpl = false; }
    }
  }
}
console.log('--- 扫描 81-130 行后 inTpl =', inTpl, '最后开始于行', tplStart);
