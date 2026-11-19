# rtk parity 改动审查报告（code-reviewer）

- 审查对象：`D:/Code/DSH-Rtk-rewrite` 工作区未提交改动（基线 `HEAD=9ba22eb`，v1.1.13）
- 审查时间：2026-11-20 03:00–03:25 (+08:00)
- 审查依据：`.planning/2026-11-20-rtk-parity/rtk-rewrite-behavior-spec.md`（已三次修正版）
- 实测环境：Windows / Node v26.13.0 / `rtk 1.2.1`（`C:/Users/Sjc/.local/bin/rtk.exe`，
  `sha256=54a980783fc18816b51f2100d714fbe1c7ce1c3f9d88d65f38dd17ac849a0c25`，18,560,000 字节）

工作区改动快照（`git diff --stat HEAD`）：

```
 README.md    | 133 ++++++++++++++++++++++++++++-
 README_zh.md | 111 +++++++++++++++++++++++-
 index.js     |  78 +++++++++++++----
 test.js      | 275 ++++++++++++++++++++++++++++++++++++++++++++++++++++-------
 4 files changed, 543 insertions(+), 54 deletions(-)
```

---

## 第一段：基线认知（先于改动建立，已按当前代码复核）

### 1.1 当前 `isRtkInvocation` 与上游守卫的独立核对

上游 `registry.rs` 的两处守卫（`git grep -n 'starts_with("rtk ")' origin/develop`）：

```
832:    if !has_compound && (trimmed.starts_with("rtk ") || trimmed == "rtk") {
2004:    if cmd_part.starts_with("rtk ") || cmd_part == "rtk" {
```

（注：这两个行号是 `origin/develop`=`24ff2267` 的行号；本地 `HEAD`=`bd7f87eb` 上分别是
836 / 2008。规范与代码注释都统一用了 origin/develop 的 832/2004，见 P2-1。）

插件侧与上游的差异点（我自己的核对结论，非照抄规范）：

| 维度 | 上游 rtk | 插件 `isRtkInvocation` | 方向 |
|---|---|---|---|
| 大小写 | 字面量、大小写敏感（`RTK …` → exit 1） | 归一为小写后判定 | 插件更宽，跳过的是 rtk 本来就 exit 1 的命令 |
| 路径形式 | 不解析路径（`./rtk`、`/usr/.../rtk`、`rtk.exe` → exit 1） | 取 basename 后判定 | 同上 |
| 引号包裹首词 | 不剥离引号（`"rtk" …` → exit 1） | 剥离配对引号 | 同上 |
| `ENV=x` 前缀 | 不剥离（`FOO=1 rtk …` → exit 1） | 循环剥离赋值前缀 | 同上 |
| 复合命令整体 | 只对**非复合**做整体短路；复合走 `rewrite_compound` 逐段 | 分段判定，全部段都是 rtk 才跳过 | 结论一致 |
| **首尾空白** | 比较 `trim()` 后的行，并回吐 trim 后形态（`"  rtk git status"` → exit 3 + `rtk git status`） | 改动前：`trimStart` 后判定 → skip=true（**漏一次去空白归一化**） | **唯一真实分歧**，本轮已修 |

### 1.2 我预判的三类回归风险（第二轮已逐条实测验证）

1. **修前导空白分歧时误伤正常跳过路径** —— 若把空白处理写在分段判定之后，或写成
   `trimStart()` 而非 `trim()`，会出现「尾随空白 / 制表符漏判」或「已跳过路径被重新 spawn」。
2. **exit 0 与 exit 3 写成不对称** —— 只认 3 或只认 0；规范 §⑦.2 已定论
   `RTK_REWRITE_HOST=openclaw` 会把 3 抬成 0，两条都必须采纳。
3. **注释与代码再次脱节** —— 尤其是「上游行号」「`exit 2` 恒无输出」这类强断言注释。

### 1.3 「迁就实现」而非「裁判实现」的断言（基线结论，第二轮复核后更新）

- `emptySegmentCases`（`test.js` `rtk git status;;` / `rtk && ` / `&& rtk …` 等 9 条判 true）：
  我逐条问真 rtk，全部 **exit 1**（见 §2.7 证据），即「判 true」不会漏改写 —— 属**安全但非裁判**：
  它们锁的是插件内部的宽松度，不是上游行为。可接受，记录为 P2。
- `C` 组「不产生 `rtk rtk` 双重改写」正则：判定的是最终命令文本，属行为断言，裁判性合格。
- `G` 组 `[无等价] … → 原样透传`：用 `realRewrite` 当预言机，裁判性合格。

---

## 第二段：逐条问题

### P0（阻塞发布）

无。

### P1（应当修）

#### P1-1 `test.js` 的「假/真 rtk 保真度」注释与实际不符，且该注释是 C 组全部断言的可信度前提

- **位置**：`test.js:77`（改动前即存在，本轮未修）
  ```
  //  - 有 `--` 隔离时，11 条命令上假/真 rtk 输出完全一致（实测差异 0）。
  ```
- **证据**（我按该注释字面复现，11 条命令逐条对比假 rtk 的 `exit3` 分支与真 rtk）：
  ```
  $ node .planning/2026-11-20-rtk-parity/review-fakecheck2.mjs
  same  "git status"                 fake="rtk git status"           real(exit 3)="rtk git status"
  same  "ls -la"                     fake="rtk ls -la"               real(exit 3)="rtk ls -la"
  DIFF  "git status && git log"      fake="rtk git status && git log"          real(exit 3)="rtk git status && rtk git log"
  DIFF  "git status; git log"        fake="rtk git status; git log"            real(exit 3)="rtk git status; rtk git log"
  DIFF  "git status || git log"      fake="rtk git status || git log"          real(exit 3)="rtk git status || rtk git log"
  same  "rtk git status"             fake="rtk git status"           real(exit 3)="rtk git status"
  same  "rtk"                        fake="rtk"                      real(exit 3)="rtk"
  same  "  rtk git status"           fake="rtk git status"           real(exit 3)="rtk git status"
  DIFF  "FOO=1 git status"           fake="rtk FOO=1 git status"     real(exit 3)="FOO=1 rtk git status"
  DIFF  "cat -n f.txt"               fake="rtk cat -n f.txt"         real(exit 3)="rtk read -n f.txt"
  same  "git status | head -5"       fake="rtk git status | head -5" real(exit 3)="rtk git status | head -5"
  差异条数 5 / 11
  ```
  假 rtk 只是机械地在整串前加 `rtk `，**不模拟分段改写**，所以复合/管道/别名重映射（`cat -n` → `rtk read -n`）
  必然不一致。注释声明的「差异 0」为假。
- **影响**：不是功能缺陷（C 组的断言本身只依赖「exit 3 + 前导加 rtk」这一条简化语义，够用），
  但注释把「假 rtk ≈ 真 rtk」写成已测事实，属于注释与事实脱节；后续若有人据此扩展 C 组断言会踩坑。
- **建议**：改成如实表述，例如「假 rtk 只复刻『整串前加 rtk』与 trim 语义；分段改写、别名重映射
  （`cat -n`→`rtk read -n`）、`ENV=x` 前缀保留等 5/11 条与真 rtk 不同，故 C 组只断言
  『不产生 rtk rtk』与『形态不被破坏』，不断言与真 rtk 逐字节相同」。

#### P1-2 `index.js` 新增的「透明前缀不会被误判」不变量，只由 C2 组（真 rtk）覆盖；CI 跑 `RTK_TEST_FAST=1` 时完全没有裁判

- **位置**：`index.js:234-242` 注释（`uv run` / `timeout` / `time` / `nice` / `noglob` / `command` /
  `builtin` / `exec` / `nocorrect` 明确不在穿透名单）；`.github/workflows/publish.yml:71-74`（CI 一律 `RTK_TEST_FAST=1`）
- **证据**：我构造变异体 `mE_prefix_misjudged.js`（把上述前缀 + `rtk` 直接判 `true`），两种模式分别跑：
  ```
  # 非 FAST（本机有 rtk）
  $ RTK_TEST_TARGET=.planning/2026-11-20-rtk-parity/mutants/mE_prefix_misjudged.js node test.js
  总计 537 项：通过 530 / 失败 7 / 与契约不一致 0
    · [C2. 恒等守卫对拍（真 rtk）] 透明前缀「uv run rtk git status」→ 插件不得误判为已是 rtk 调用（§⑤） — 插件 skip=true
    · …「time rtk git status」/「noglob …」/「command …」/「exec …」/「nocorrect …」/「nice …」同样 FAIL
  RESULT: FAIL

  # FAST（= CI 的跑法）
  $ RTK_TEST_FAST=1 RTK_TEST_TARGET=…mE_prefix_misjudged.js node test.js
  总计 300 项：通过 300 / 失败 0 → RESULT: ALL PASS      ← 变异体存活
  ```
  而 C 组（假 rtk，任何环境都跑）的 `guardCases` 里**没有任何透明前缀用例**，
  E 组纯函数单测的 `yes/no` 列表同样没有（`grep -nE 'uv run|timeout|noglob|nocorrect|nice' test.js` 在
  E 组区间无命中）。也就是说：这条被写进 `index.js` 注释、被 lead 列为 §⑤ 硬要求的不变量，
  在发布门禁上无人裁判。
- **影响**：若将来有人「优化」`isRtkSegment` 去穿透 `uv run`，本地非 FAST 会红、CI 却全绿直接发版。
  安全后果有限（§⑦.1 实测这些形态 rtk 都 exit 1，跳过不漏改写），但违反「测试须裁判实现」。
- **建议**：在 C 组（假 rtk）补 2–3 条 `checkDivergence`/`check` 断言：
  `isRtkInvocation('uv run rtk git status') === false`、`'nice rtk git status' === false`、
  `'noglob rtk git status' === false`。假 rtk 上这些命令会走 spawn 并得到 `rtk uv run rtk git status`，
  足以区分判定分支，不需要真 rtk。

#### P1-3 README「9 组」与实际 14 组不符，且清单漏了本轮新增的 C2 组

- **位置**：`README.md:534`（`9 groups`）、`README.md:645`（`(9 groups)`）、
  `README_zh.md:449`（`9 组`）、`README_zh.md:542`（`（9 组）`）；清单在 `README_zh.md:450-459`
- **证据**：
  ```
  $ RTK_TEST_FAST=1 node test.js 2>&1 | grep -cE '^── '
  14
  $ RTK_TEST_FAST=1 node test.js 2>&1 | grep -E '^── ' | sed 's/  [.*//'
  ── A. rewrite 退出码契约
  ── B. rtk 缺失（ENOENT）
  ── C. 递归防护
  ── C2. 恒等守卫对拍（真 rtk）      ← 本轮新增，清单里没有
  ── D. 失败安全
  ── D2. 同步异常（catch 分支）      ← 清单里没有
  ── E0. 执行失败必须上抛（P0-1）    ← 清单里没有
  ── E1a. 以 - 开头的命令（假 rtk）
  ── E1b. 以 - 开头的命令（真 rtk）
  ── E. 纯函数单测
  ── F. 复合命令与管道（真 rtk）
  ── G. 命令族冒烟（真 rtk）
  ── H. 模块契约
  ── I. 多端 bash 执行器
  ```
  `HEAD` 版是 13 组（`git show HEAD:test.js | grep -cE "const G_[A-Z0-9]+ = '"` → 13），
  所以「9 组」在改动前就已过时；本轮新增 C2 后变成 14 组，diff 又把「C2 组新增 97 项」写进
  README 的行为对拍节，两处互相矛盾。
- **影响**：文档数字失真，用户按 README 核对会认为文档与套件不一致。
- **建议**：改成「14 组」，并补齐 C2 / D2 / E0 / E1a / E1b 五个组名；或者直接删掉具体组数字，
  只保留「以末尾统计行为准」（README 已有这句，可把组数彻底去掉）。

#### P1-4 `test.js` 新增的死变量 `msg`（lint 级噪音，非功能问题）

- **位置**：`test.js:409`
  ```js
  const msg = 'rtk: pipeline rule blocked this pipeline';
  ```
- **证据**：`grep -n 'msg' test.js` 只有 3 处命中 —— `test.js:116`（假 rtk 分支内的字符串）、
  `test.js:409`（该声明）、`test.js:410`（`FAKE_SCENARIO` 赋值）。声明后从未被引用；
  后续断言用的是字面量 `'pipeline rule blocked'`。
- **影响**：无功能影响；但项目是零依赖无 lint，这类残留会累积。
- **建议**：删掉该行，或把后续 `check` 里的字面量改用 `msg`。

#### P1-5 恒等抑制（`rewritten !== spec.command`）的唯一裁判断言与 `log()` 耦合，可被「连坐删除」绕过

- **位置**：`index.js:366` `if (rewritten && rewritten !== spec.command) {`；裁判断言在
  `test.js` A 组「恒等输出 → 不打印改写日志（因为没有实际改写）」
- **证据**：变异体 `m7_identity_and_no_log.js` 把「恒等抑制」与它内部那行 `log(...)` 一起删掉：
  ```
  $ node .planning/2026-11-20-rtk-parity/review-mutate2.mjs
   { "name": "m7_identity_and_no_log", "exitCode": 0, "total": "300", "passed": "300", "failed": "0",
     "verdict": "GREEN(存活)" }

  $ RTK_TEST_TARGET=…m7_identity_and_no_log.js node test.js      # 非 FAST
  总计 537 项：通过 537 / 失败 0 → RESULT: ALL PASS               # 仍存活

  # 对照：m3 只删抑制、保留 log() → 被捕获
  $ RTK_TEST_TARGET=…m3_accept_identity.js node test.js
  总计 537 项：通过 536 / 失败 1
    · [A. rewrite 退出码契约] 恒等输出 → 不打印改写日志（因为没有实际改写） — 实际日志: ["[rtk-rewrite] \"git status\" -> \"git status\""]
  ```
  即：删抑制 + 删日志 = 无差异（因为唯一裁判断言就在日志上）；删抑制但留日志 = 被抓。
- **影响**：功能上恒等抑制失效不会造成错误执行（`super.execute` 拿到的文本相同），所以不是
  正确的功能缺陷；但**这条不变式在测试里的裁判强度实际为 0**（一旦有人同时删两行），
  与 README「The byte-identical comparison above is kept as the last line of defence」的
  定位不符。
- **建议（已实测可行）**：加一条不依赖 `log()` 的断言，用**引用相等**区分两条分支 ——
  抑制成立时 `super.execute` 收到的是原 `spec` 对象；走改写分支时收到的是新对象
  `{...spec, command: rewritten}`。假执行器已经把 `spec` 原样 push 进 `globalThis.__rtkSpecs`，
  所以只需在 A 组的 `identity` 场景里加一行：
  ```js
  const spec = { command: 'git status' };
  await executor.execute(spec);          // FAKE_SCENARIO='identity'
  check(G_A, '恒等输出 → 交回的必须是原 spec 引用（未构造新对象）',
    globalThis.__rtkSpecs.at(-1) === spec, '构造了新对象，说明走了改写分支');
  ```
  我用假 rtk（`RTK_BIN=node` + cwd 里的 `rewrite` 脚本，与 test.js 同款注入方式）实测三种实现：
  ```
  $ node .planning/2026-11-20-rtk-parity/review-refcheck.mjs
  current(has-guard)       sameRef=true   calls=1 cmd="git status" logCount=0
  m3(no-guard,log-kept)    sameRef=false  calls=1 cmd="git status" logCount=1
  m7(no-guard,no-log)      sameRef=false  calls=1 cmd="git status" logCount=0
  ```
  即：该断言在正确实现上为 true，在 m3（只删抑制）与 m7（抑制+日志都删）上均为 false ——
  **对 m7 有裁判力，而现有唯一断言没有**。成本 1 行，建议采纳。

### P2（可接受、记录）

#### P2-1 上游行号引用只对 `origin/develop` 成立，对本地 `HEAD` 偏移 4 行，但注释未标注 ref

- **位置**：`index.js:209`、`index.js:211`、`index.js:221`、`README.md:599-600`、
  `README_zh.md:505`、`test.js:519`、`test.js:979`
- **证据**：
  ```
  $ cd /d/Code/_upstream/rtk && git show origin/develop:src/discover/registry.rs | grep -n 'starts_with("rtk ")'
  832:    if !has_compound && (trimmed.starts_with("rtk ") || trimmed == "rtk") {
  2004:    if cmd_part.starts_with("rtk ") || cmd_part == "rtk" {
  $ git show HEAD:src/discover/registry.rs | grep -n 'starts_with("rtk ")'
  836:    if !has_compound && (trimmed.starts_with("rtk ") || trimmed == "rtk") {
  2008:    if cmd_part.starts_with("rtk ") || cmd_part == "rtk" {
  ```
  而 `README.md:598` / `README_zh.md:504` 明确写了 `origin/develop` = `dev-1.2.0-rc.620-147-g24ff2267`，
  所以 README 里的 832/2004 有出处；但 `index.js` 的注释只写「line numbers as of rtk 1.2.1」，
  没说是哪个 ref。本地 `HEAD` 是 `bd7f87eb`（`dev-1.2.0-rc.620-0-gbd7f87eb`），差 4 行。
- **建议**：在 `index.js` 注释里补一句「as of `origin/develop` @ 24ff2267；本地 `bd7f87eb` 上为 836/2008」。

#### P2-2 `index.js:208` 的「上游守卫」句式仍写成「mirrors」，但守卫实际比上游宽

- **位置**：`index.js:208`
  ```
  * Upstream guard this mirrors (`registry.rs`, line numbers as of rtk 1.2.1):
  ```
  紧接的 `223` 行又写「This fast path is wider than upstream on three axes」。
- **评估**：同一段里先说 mirrors 再说 wider，读起来像自我矛盾；但后面把三条放宽轴和
  「每条都只跳过上游会 exit 1 的 spawn」讲清楚了，语义上不算错。属措辞。
- **建议**：把 `mirrors` 改成 `approximates` 或 `extends`，与下一段一致。

#### P2-3 `index.js` 的空白短路用 `String.prototype.trim`，其空白字符集比 Rust 的 `trim()` 少一个 `U+0085 (NEL)`

- **位置**：`index.js:268` `if (text !== text.trim()) return false;`
- **证据**（穷举 28 个 Unicode White_Space / 零宽码点，各测 lead / trail 两种位置，共 84 点）：
  ```
  $ node .planning/2026-11-20-rtk-parity/review-whitespace.mjs
  测点数 84 | 真实漏改写 1
  === 真实漏改写明细 ===
  {"cp":"U+0085","label":"trail","skip":true,"code":3,"out":"rtk git status","jsTrim":false,"realDiv":true}
  ```
  即 `"rtk git status" + U+0085`：JS `trim()` **不**移除 NEL（`jsTrim=false`），于是走分段判定 → 
  `segments.every(isRtkSegment)` 为 true → 跳过；而 rtk 的 Rust `trim()` 移除了 NEL，回吐
  `rtk git status`（一次真实改写）。语义不变（只少去一个控制字符），且该形态在真实 shell 输入里
  基本不会出现（NEL 不是终端可输入字符）。
- **与前缀的对比**：`NEL + "rtk git status"`（lead）时 JS 也不 trim，但 `isRtkSegment` 的
  `trimStart()` 同样不移除 NEL，首词变成 `\u0085rtk` → 判 false → 交给 rtk，**没有漏改写**。
  所以只有 trail 位置是真实分歧。
- **建议**：可接受不修；若要彻底对齐，把短路条件从 `text !== text.trim()` 改为
  `/[^\S\r\n]|^\s|\s$/.test(text)` 之类的显式集合，或在 `RTK_TEST_SOFT=1` 语义下记一条已知差异。
  建议只在报告里记录，不必为它增加代码。

#### P2-4 `README` 的 `总用例: 47 | 分歧(漏改写): 1` 已在当前代码下变为 `0`，文档未同步

- **位置**：`README.md:628`、`README.md:632-636`、`README_zh.md:527`、`README_zh.md:531-533`
- **证据**：
  ```
  $ node .planning/2026-11-20-rtk-parity/probe-parity.mjs
  总用例: 47 | 分歧(漏改写): 0
  --- 分歧明细（插件跳过但 rtk 会改写）---
  （空）
  ```
  文档仍贴旧输出 `分歧(漏改写): 1`，并写「唯一分歧是 `"  rtk git status"`…分歧计数目标为 0，
  当前为 47 条里 1 条」。修复后应为 0 条，且「插件判为 rtk 调用而不 spawn」这句已不成立。
  47 这个数字本身是对的（`review-count` 脚本按字面量统计 → 47）。
- **影响**：文档描述的行为与代码不符，且恰好把「本轮修掉的那个分歧」写成仍然存在。
- **建议**：更新为 `总用例: 47 | 分歧(漏改写): 0`，并把说明改成「修复后该分歧已消除；
  `probe-parity.mjs` 里的 `"  rtk git status"` 用例现在判 skip=false，会交给 rtk 得到 trim 后的形态」。

#### P2-5 `README` 里的两台机器的绝对路径 / 用户名（既有内容，本轮新增处沿用）

- **位置**：`README.md:252`、`README_zh.md:214`（`C:/Users/Sjc/.local/bin/rtk.exe`）、
  `README.md:597`、`README_zh.md:503`（`/d/Code/_upstream/rtk`）
- **评估**：README 是 npm 包 `files` 白名单内的发布物（`package.json` `files` 含两份 README），
  这些路径会随包发布。作为「本机实测记录」可接受，但公开包里写死个人用户名/盘符路径不是最佳实践。
- **建议**：可接受；若在意可改成占位符 `<rtk path>` / `<upstream clone>`。

#### P2-6 `test.js` 的 `emptySegmentCases`（9 条判 true）不构成裁判，只锁插件宽松度

- **位置**：`test.js:1015-1027`（`'rtk git status;;'` / `'rtk git status &&'` / `'&& rtk git status'` / `'rtk;rtk'` 等）
- **证据**（逐条问真 rtk，全部 exit 1，即跳过不漏改写）：
  ```
  $ node .planning/2026-11-20-rtk-parity/review-emptyseg.mjs
           skip=true  exit=1  "rtk git status;;"             -> ""
           skip=true  exit=1  "rtk git status &&"            -> ""
           skip=true  exit=1  "rtk git status ||"            -> ""
           skip=true  exit=1  "&& rtk git status"            -> ""
           skip=true  exit=1  "rtk git status && && rtk ls"  -> ""
           skip=true  exit=1  "rtk;rtk"                      -> ""
           skip=true  exit=1  "rtk&&rtk"                     -> ""
           skip=true  exit=1  "rtk  git  status"             -> "rtk  git  status"
           skip=true  exit=1  "rtk git status\n\nrtk ls"     -> ""
  ```
- **评估**：安全（不会漏改写），但它是「按实现写的断言」而非「按上游写的断言」；且
  `'rtk  git  status'` 那条 rtk 实际 exit 1（不是注释说的「回吐」），断言 true 也只是实现口径。
- **建议**：保留（有回归价值，防分段判定被改坏），但在组注释里标明「这是插件侧宽松度契约，
  上游对这些形态一律 exit 1，跳过不漏改写」。可视为已记录。

---

## 变异验证结果（我独立构造，非 lead 提供的 4 个）

变异体全部放在 `.planning/2026-11-20-rtk-parity/mutants/`，用 `RTK_TEST_TARGET` 指向后跑
真实 `test.js`；`RTK_TEST_FAST=1` 用于区分「CI 是否也能捕获」。

| # | 变异体 | 变异内容 | FAST 结果 | 非 FAST 结果 | 判定 |
|---|---|---|---|---|---|
| mA | `mA_no_whitespace_shortcircuit` | 删掉 `if (text !== text.trim()) return false;`（回到修复前） | **RED** 300→293（7 fail） | — | 捕获；证明新守卫有裁判 |
| mB | `mB_flat_prefix_guard` | `isRtkInvocation` 退回单串 `startsWith('rtk ')` | **RED** 300→248（52 fail） | — | 捕获 |
| mC | `mC_prefix_misjudged` | 透明前缀 + rtk 直接判 true（含空白短路被污染版） | **RED** 300→293（7 fail） | — | 捕获（但失败项与 mA 同源，见 mE） |
| mE | `mE_prefix_misjudged` | **纯**透明前缀误判（不污染空白短路） | **GREEN 300/300 全绿 = 存活** | **RED** 537→530（7 fail，全在 C2 组） | **CI 缺口，即 P1-2** |
| m3 | `m3_accept_identity` | 去掉恒等抑制 `rewritten !== spec.command` | **RED** 300→299（1 fail） | **RED** 537→536（1 fail） | 捕获，但只有 1 条断言裁判 |
| m7 | `m7_identity_and_no_log` | 同时去掉恒等抑制与改写日志 | **GREEN 300/300 = 存活** | **GREEN 537/537 = 存活** | 见 P1-5 |
| m6 | `m6_prefix_misjudged_as_rtk` | 早期版本的前缀误判变异体 | 未构建（原代码片段已变，脚本报 BUILD-FAILED） | — | 由 mE 取代 |

其它已复核的变异体（沿用早期脚本）：

| # | 变异内容 | 结果 |
|---|---|---|
| m2 | 删 exit 3 采纳分支（只认 exit 0） | FAST RED 300→273（27 fail） |
| m4 | exit 2 也采纳 stdout | FAST RED 300→297（3 fail，含 `★ exit 2 + 非空 stdout` 两条） |
| m5 | 去掉 `ENV=x` 前缀剥离 | FAST RED 300→296（4 fail） |

**关于 m7 的说明**：该变异体把恒等抑制与 `log()` 一起删掉，现行套件全绿（FAST 300/300、
非 FAST 537/537）。原因是测试对恒等抑制的裁判**只有一条**断言 —— `恒等输出 → 不打印改写日志`；
一旦把 `log()` 也删了，这条断言就失去区分力，而「最终执行原命令」「只 spawn 一次 rtk」
「只执行一次 super.execute」这几条在「无抑制但文本相同」时依然成立（`super.execute` 拿到的字符串一样）。
对照 m3（只删抑制、保留 `log()`）仍被抓到 1 fail，可见抑制本身有裁判，只是裁判与被删的 `log()` 强耦合。
这不是本轮引入的回归，但属裁判性缺口，见 **P1-5**。

---

## 关于 lead 提出的四点重点

### 1. 空白短路的位置与是否漏掉某种空白

- 位置正确：`index.js:262-271`，短路在 `splitSegments` 之前，早于任何分段判定。
- `\r\n` 混合：`'rtk git status' + CR + LF` → skip=false，交给 rtk 得 `rtk git status`，正确。
- 中间行带前导空白（整条首尾无空白）：`'rtk git status\n  rtk ls'`、`'…\n\trtk ls'`、
  `'rtk git status &&   rtk ls'`、`'rtk ls |   rtk grep x'` → 全部 skip=true，而 rtk 对这四条
  **全部 exit 1**（`review-emptyseg` / 专门用例实测），没有漏改写。这条路径不需要短路，因为
  `isRtkSegment` 本身会先 `trimStart`。
- 唯一例外是 §P2-3 的 `U+0085 (NEL)` trail 位置：JS `trim()` 不移除、Rust `trim()` 移除，
  造成 1 条真实分歧（语义不变，仅少去一个控制字符）。

### 2. 「插件跳过集合 ⊆ rtk 不改写集合」在我自己的用例集上是否仍成立

我写了 `review-bigmatrix.mjs`，按「词干 × 分隔符 × 尾部 × 空白包裹」组合生成 **1009 条**独立用例
（不是 lead 给的 47 条）：

```
$ node .planning/2026-11-20-rtk-parity/review-bigmatrix.mjs
总用例 1009 | 插件跳过 137 | 真实漏改写 0 | 仅排版差异 0
--- 真实漏改写明细 ---
（空）
--- 仅排版差异（rtk 回吐去空白形态）---
（空）
--- 插件不跳过但 rtk 有实质改写（安全，多一次 spawn）---
  计数 17
```

另有 23 条边界用例（`review-edge.mjs`）与 48 条定向用例（`review-parity2.mjs`）：
**真实漏改写 0**。结合空白码点穷举（84 点，1 条 NEL 例外），结论：
**在当前实现下，除 `U+0085` 尾随这一条语义等价的分歧外，「插件跳过 ⊆ rtk 不改写」成立。**

### 3. README 是否把「未实测」写成「已确认」

- exit 2 带消息：**如实标注，没问题**。
  `README.md:275-281`「The "exit 2 with a message" row rests on upstream source and help text only;
  it could **not be produced on this machine**」；`README_zh.md:233-237`
  「**exit 2 带消息这条只有上游源码与 help 文案支撑，本机未能构造。**…没有实测样本」。
  上游复核支持该表述：`git grep -n 'process::exit(2)' origin/develop -- src/` 只有
  `rewrite_cmd.rs:122`（代码）与 `:235`（文档注释）两处命中。
- 另有 P2-4 的反向问题：把**已修掉**的分歧仍写成「当前为 47 条里 1 条」，属「旧实测未更新」，
  不是「未实测写成已确认」，但同样要改。

### 4. P0 级阻塞项

**无。** 详见下方结论。

---

## 总体结论

**修完 P1 可发布。**

- 功能正确性：`index.js` 的四处改动（空白短路守卫 / 恒等守卫 JSDoc 重写 / 文件头描述 /
  exit 0 注释）中，只有第一处是行为改动，且它精确修掉了规范 §③ 的唯一真实分歧；
  我在 1009 + 48 + 23 + 84 条独立用例上验证「插件跳过 ⊆ rtk 不改写」成立（唯一 NEL 例外语义等价）。
- 发布契约：`git diff HEAD -- package.json cordis.patch.yml` 为空；
  `git diff HEAD -- index.js | grep -E '^[+-]export'` 为空 —— **导出面、peer 范围、patch 文件
  与退出码语义均未变化**，已发布的 1.1.13 行为契约不受影响（默认路径行为更严格地贴近上游，
  唯一行为变化是「带首尾空白的 rtk 命令现在会 spawn 一次 rtk 并采纳 trim 后的形态」，这属于修复）。
- 门禁：`node test.js` → 537/537 ALL PASS；`RTK_TEST_FAST=1`（CI 跑法）→ 300/300 ALL PASS；
  `probe-parity.mjs` → 47 条、分歧 0。
- 必须先修的 P1：P1-1（假/真 rtk 保真度注释失真）、P1-2（透明前缀不变量在 CI 无裁判）、
  P1-3（README 组数与组清单失真）、P1-4（死变量 `msg`）、P1-5（恒等抑制的裁判可被连坐删除绕过）。
  五条都不影响运行时正确性（我已用 1009+48+23+84 条用例与 9 个变异体验证「插件跳过 ⊆ rtk 不改写」，
  唯一例外是语义等价的 NEL 尾随空白），但前四条属「文档/测试与实现不一致」，正是本次改动的主题；
  P1-5 是裁判性缺口，宜在本轮顺手补 1 行断言。
- P2 四条（行号 ref 标注、mirrors 措辞、NEL 空白集差异、README 47→0 未同步、私有路径）
  可记录不改，其中 **P2-4（README 分歧数仍写 1）建议一并修**，因为它直接描述本轮修复对象。

---

## 附：本次审查产出的可复现脚本（均在 `.planning/2026-11-20-rtk-parity/`）

| 脚本 | 用途 | 关键输出 |
|---|---|---|
| `review-bigmatrix.mjs` | 1009 条组合用例对拍 | 真实漏改写 0 |
| `review-parity2.mjs` | 48 条定向用例（含透明前缀 / 引号 / 路径 / ENV 前缀） | 真实漏改写 0 |
| `review-edge.mjs` | 23 条边界（CRLF / 注释 / 替换 / 分组 / 块关键字） | 真实漏改写 0 |
| `review-whitespace.mjs` | 28 个空白码点 × lead/trail | 1 条 NEL trail 真实分歧 |
| `review-emptyseg.mjs` | 空段 / 多余操作符 9 条 | 全部 rtk exit 1 |
| `review-mutate.mjs` | 变异 m1–m5 | m1 因代码变更失配，m2/m3/m4/m5 全捕获 |
| `review-mutate2.mjs` | 变异 m6/m7 | m7 存活（见变异表说明） |
| `review-mutate4.mjs` | 变异 mA/mB/mC | 全捕获 |
| `review-headcmp2.mjs` | 修复前(HEAD)与修复后判定对比 | 仅 `"  rtk git status"` 由 true→false |
| `review-fakecheck2.mjs` | 假/真 rtk 11 条保真度复核 | 差异 5/11（P1-1 证据） |
| `review-compound.mjs` | 规范 §④ compound 12 条 | 与规范表逐条一致 |
| `review-gen-mE.mjs` | 生成纯透明前缀变异体 | 用于 P1-2 证据 |
| `review-refcheck.mjs` | 引用相等断言在 current / m3 / m7 上的区分力 | 用于 P1-5 证据（true / false / false） |
| `review-mkshim.mjs` | 建最小假 dsh 包 + 假 rtk（供 refcheck 用） | 零依赖复现 P1-5 |
| `review-ws.mjs` | 带空白 rtk 命令的 rtk 实测（8 条） | 全部 exit 3 + trim 形态，无 rtk rtk |
| `review-emptyseg.mjs` | 空段 / 多余操作符 9 条 | 全部 rtk exit 1（P2-6 证据） |

**环境限制声明**：本次审查仅写 `review-report.md` 与本目录下的 `review-*.mjs` 脚本，
未修改 `index.js` / `test.js` / `README*` / `package.json` / `cordis.patch.yml` 任何一个字节
（`git status --porcelain` 中这四项的改动全部来自实现者）。
