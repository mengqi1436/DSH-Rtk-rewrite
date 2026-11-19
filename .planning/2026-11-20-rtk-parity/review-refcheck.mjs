import { pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = process.cwd();
process.env.DSH_INSTALL_PACKAGE_JSON = path.join(ROOT, '.planning/2026-11-20-rtk-parity/fakedsh/package.json');
process.env.RTK_BIN = process.execPath;
process.chdir(path.join(ROOT, '.planning/2026-11-20-rtk-parity/fakebin'));
const mods = {
  'current(has-guard)': path.join(ROOT, 'index.js'),
  'm3(no-guard,log-kept)': path.join(ROOT, '.planning/2026-11-20-rtk-parity/mutants/m3_accept_identity.js'),
  'm7(no-guard,no-log)': path.join(ROOT, '.planning/2026-11-20-rtk-parity/mutants/m7_identity_and_no_log.js'),
};
for (const [label, file] of Object.entries(mods)) {
  const m = await import(pathToFileURL(file).href + '?r=' + Date.now() + Math.random());
  const ex = new m.default({});
  globalThis.__rtkSpecs = [];
  const spec = { command: 'git status' };
  const cap = { log: [], warn: [] };
  const ol = console.log, ow = console.warn;
  console.log = (...p) => cap.log.push(p.join(' '));
  console.warn = (...p) => cap.warn.push(p.join(' '));
  try { await ex.execute(spec); } finally { console.log = ol; console.warn = ow; }
  const got = globalThis.__rtkSpecs.at(-1);
  console.log(label.padEnd(24), 'sameRef=' + String(got === spec).padEnd(6), 'calls=' + globalThis.__rtkSpecs.length, 'cmd=' + JSON.stringify(got && got.command), 'logCount=' + cap.log.length);
}