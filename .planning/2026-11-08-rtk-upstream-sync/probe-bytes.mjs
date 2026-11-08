// 审查实验 11：逐字节核对 index.js / test.js 里的转义层数（避免模板/JSON 二次转义误判）。
import { readFileSync } from 'node:fs';

function dump(file, needles) {
  const src = readFileSync(file, 'utf8');
  console.log('===== ' + file + ' =====');
  for (const needle of needles) {
    const i = src.indexOf(needle);
    if (i === -1) { console.log('  未找到: ' + needle); continue; }
    const line = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
    console.log('  源码行: ' + line);
    console.log('  字节:    ' + JSON.stringify(line));
    // 找出该行里所有转义序列
    const escapes = [...line.matchAll(/\\./g)].map((m) => m[0] + ' U+' + m[0].charCodeAt(1).toString(16).padStart(4, '0'));
    console.log('  转义:    ' + JSON.stringify(escapes));
    console.log('');
  }
}

dump('D:\\Code\\DSH-Rtk-rewrite\\index.js', [
  'function splitSegments',
  'const end = text.search',
  "if (ch === ';'",
  "return RTK_EXE_NAMES.has",
]);

dump('D:\\Code\\DSH-Rtk-rewrite\\test.js', [
  "['换行分隔'",
  'whitespace',
  "const nasty",
  "'rtk\\r\\ngit status'",
]);
