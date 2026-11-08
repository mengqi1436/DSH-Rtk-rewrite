# 终审报告（第二轮）— dsh-pwsh-rtk-rewrite

审查基线：`index.js` 264 行 sha256 `9cad3b2f…`、`test.js` 1035 行 sha256 `651a444d…`、`publish.yml` sha256 `8af2c699…`
实测环境：Windows 11 / node v26.13.0 / **rtk 0.49.0**（任务期间被外部替换，见 §4）/ dsh 内核 0.2.2-rc.1
本轮新增探针：`final-r2-ci.mjs`、`final-p01true.mjs`、`final-p01dump.mjs`、`final-equivalence.mjs`、`final-fakefidelity.mjs`（5 个，全部只读）

---

## 一、lead 指定的两个聚焦问题

### 1　P1-3 确认闭合 —— ✅ 闭合，且我在 CI 环境下验证了「锁得住」

**CI 环境复现（`PATH` 换成空目录，node 走绝对路径）**：

```
$ PATH="/tmp/nortk" RTK_TEST_FAST=1 "$(which node)" test.js; echo "CI_EXIT=$?"
── E1a. 以 - 开头的命令（假 rtk，任何环境都跑）  [44/44]
── E1b. 以 - 开头的命令（真 rtk）  [1/1]
总计 258 项：通过 258 / 失败 0 / 与契约不一致 0
RESULT: ALL PASS
CI_EXIT=0
```

**最关键的一条 —— R2/R3 回退变异在 **FAST + 无 rtk** 环境下是否仍变红**（`final-r2-ci.mjs`）：

| 变异体 | FAST+noRtk（= CI） | FULL+有rtk（= 本地） |
|---|---|---|
| BASE（未变异） | GREEN pass=258 | GREEN pass=365 |
| **R2 去掉 `--` 隔离（恢复 P1-1）** | **RED pass=227 fail=31** | RED pass=328 fail=37 |
| **R3 半修，只特判 `-h`** | **RED pass=230 fail=28** | RED pass=333 fail=32 |

R2 在 CI 环境的首批失败项就是 E1a 的断言：

```
FAIL 「-h」→ 最终执行内容不得是 help 文本
FAIL 「-h」→ 最终执行的就是原命令
FAIL 「-h」→ 调用 rtk 时带了 -- 隔离符
FAIL 「--help」→ 最终执行内容不得是 help 文本
```

**结论**：假 rtk 确实锁住了 P1-1，CI 上不再是无覆盖。而且 `test.js:685-687` 额外断言了 `calls[0].isolated === true` —— 这不只是"结果对"，还验证了「`--` 真的下发给 rtk」，杜绝了"碰巧通过"。

### 1b　假 rtk 的建模保真度（我额外查的，lead 没要求但影响判据可信度）

`final-fakefidelity.mjs` 把假 rtk 与真 rtk 0.49.0 逐条对比：

| 命令 | 假rtk(未隔离) | 真rtk(未隔离) | 一致? |
|---|---|---|---|
| `-h` / `--help` / `-hh` | exit=0 吐 help | exit=0 吐 help | ✅ |
| `-v` / `--version` / `--` / `--skip-env` / `-help` / `--HELP` / `-H` / `-x ls` | exit=0 吐 help | exit=1 无输出 | ❌ **假 rtk 更严格** |

**有 `--` 隔离时，11 条命令假/真 rtk 完全一致（不一致数 = 0）。**

这个"不一致"方向是安全的：假 rtk 把任何 leading-dash 都建模成"会吐 help"，比真 rtk 更危险。E1a 在这样的建模下仍要求插件输出原命令 → 是**过严建模**，只会让测试更强，不会假绿。**可接受，但建议在 test.js:71-72 的注释里补一句**：假 rtk 对 leading-dash 的 help 建模比真 rtk 0.49.0 更激进（真 rtk 只对 `-h`/`--help`/`-hh` 吐 help），以避免后人拿假 rtk 行为反推真 rtk 语义。

### 3　30/30 变异测试的两个「等价」论证 —— ✅ M25 成立，⚠️ M27 论证有瑕疵但结论成立

我用性质测试（`final-equivalence.mjs`）而不是读论证来判，因为「等价」这种断言必须能被反驳。

**M25（删掉 `while (i+1<len && '&|'.includes(cmd[i+1])) i++`）—— 真等价**

```
穷举 20736 个长度≤4 的字符串（字母表含 ; & | " ' \n 空格），差异 0 个
定向 15 条真实命令（a && b / a || b / a &| b / rtk git status && && rtk ls / echo "a&&b" …），全部一致
```

论证成立：下游 `segments.filter(s => s.trim().length > 0)` 确实把 `&&` 切开产生的空段/空白段滤掉。**这是真正的等价变异体，不是测试缺口。**

**M27（`Number(err.code) === N` → `err.code === N`）—— 我不同意"等价"，但同意"存活可接受"**

test-engineer 的论证是「当前 Node 下 `err.code` 恒为 number 或 `'ENOENT'`，后者在前面分支已拦」。我的性质测试发现反例：

```
err.code="1" N=1: Number()=true  裸比较=false
err.code="2" N=2: Number()=true  裸比较=false
err.code="3" N=3: Number()=true  裸比较=false
err.code="3 " N=3: Number()=true  裸比较=false
```

若 `err.code` 是数字字符串 `"3"`，`Number()` 版走 exit 3 分支（采纳改写），裸比较版落到 else（警告 + 执行原命令）。**两者不严格等价。**

但实测 `err.code` 的真实取值域（`final-equiv.mjs`）：

```
真 rtk git status      → code=3    type=number
真 rtk Get-ChildItem   → code=1    type=number
不存在 bin             → code="ENOENT" type=string   ← 在前面分支已拦
超时                   → code=null  killed=true      ← 走 killed 分支
```

在这个取值域内两者行为一致，所以**存活可接受**。定级 P2（措辞问题，非缺陷）：`verify-report.md:275-276` 说「行为完全一致 / 不是必需」过强，应改为「在当前 `err.code` 取值域内行为一致；若 Node 将来改用字符串退出码，`Number()` 版仍正确而裸比较版会把可改写的命令降级为透传」。这条修正会让论证从"断言"变成"防御性设计的正当理由"，更站得住。

---

## 二、P0-1 / P1-1 修复未引入新问题 —— ✅ 且我发现并纠正了自己的一个方法论错误

**此处必须交代**：我上一轮报告说「回退变异 R1 变红 → P0-1 修法已被测试锁定」。这个结论**当时的证据是假的** —— 我的 R1 变异体造成了 `ReferenceError: rewritten is not defined`（因为把 `let rewritten` 留在外层却在 try 内引用），测试是"崩溃式变红"而非"断言式变红"。我这次查清并重建了正确变异体。

**根因是一个 JS 语义细节**：

```js
try { return promise }         // ← 捕获不到 rejection（return 立即完成，promise 在 try 外 unwind）
try { return await promise }   // ← 只有这个，rejection 才进 catch
```

旧版 `index.js`（244 行）正是 `return await super.execute(...)`，所以 **P0-1 真实成立**；而修复版去掉了 `await` 并移出 try，双保险。我的第一版 R1 变异体漏了 `await`，所以造出一个"在 try 内但不抛"的假变异体（`final-p01true.mjs` 的 P01-NOAWAIT 对照印证：try 内无 await → 测试全绿）。

**用真实 P0-1 形态（try 内 + `return await`）重建后（`final-p01true.mjs`）**：

| 变异体 | CI(FAST+noRtk) | FULL(local) |
|---|---|---|
| BASELINE | exit=0 pass=258 | exit=0 pass=365 |
| **P01-TRUE（try 内 + return await）** | **exit=1 pass=249 fail=9** | **exit=1 pass=356 fail=9** |
| P01-NOAWAIT（try 内，无 await） | exit=0 pass=258（GREEN） | exit=0 pass=365（GREEN） |

P01-TRUE 的 9 条失败项全部命中 E0 组：

```
FAIL 沙箱 SandboxUnavailableError → 必须向调用方抛出
FAIL 沙箱 SandboxUnavailableError → 异常类型原样保留
FAIL 沙箱 SandboxUnavailableError → 命令只执行 1 次（不是 2 次）
FAIL 沙箱 SandboxUnavailableError → 不得降级成 warn
FAIL 已取消（AbortError）→ 必须向调用方抛出
FAIL 已取消（AbortError）→ 异常类型原样保留
```

**所以：E0 组确实锁住了 P0-1，而且 CI 环境也锁得住（9 条失败在 FAST+noRtk 下同样触发）。这是硬证据，不是推测。**

**P1-1 行为复验（`probe-dash.mjs` 终版）**：`-h`/`--help`/`-v`/`--version`/`--`/`-x ls`/`pwsh -h`/`git -h` 最终执行全等于原命令。

**P0-1 行为复验（`probe-blast.mjs` 终版）**：A 类（execute reject）三例 `调用序列=["rtk git status"]` 且异常原样上抛；B 类（result reject）不受影响。

**其他维度无回归**：

- `probe-edge3.mjs`：`undefined/null/42/{}/空串/空白/NUL/CRLF/200KB` 九种入参 `super.execute 次数=1`，无挂起；`缺失字段: []`（9 字段全保留）
- `probe-idem.mjs`：6 个幂等种子全部 ≤2 轮收敛，无无限增长

---

## 三、最终结论

**可发布。**

`node test.js` 365/365 全绿；`PATH="空目录" RTK_TEST_FAST=1` 258/258 全绿、`CI_EXIT=0`。P1-3 按修法 A 闭合，且我在 CI 环境下用回退变异 R2/R3 证明了假 rtk 真的锁得住 P1-1；P0-1 用真实缺陷形态（`return await`）验证了 E0 组在两种环境下都能捕获 9 条断言。

**无 P0、无 P1。**

**P2（不阻塞发布，建议下一轮顺手改）**：

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| P2-1 | `verify-report.md:275-276` 对 M27 的表述过强（说"完全一致/不是必需"）。性质测试显示 `err.code="3"` 时两者不等价，只是当前取值域内结果相同 | `verify-report.md` | 改为「当前取值范围一致；`Number()` 是为未来 Node 改字符串退出码留的防御」 |
| P2-2 | 假 rtk 对 leading-dash 的建模比真 rtk 0.49.0 更激进（真 rtk 只对 `-h`/`--help`/`-hh` 吐 help，假 rtk 对任何 leading-dash 都吐）。方向安全（过严），但需注明以免后人反推真 rtk 语义 | `test.js:71-72` 注释 | 补一句建模边界说明 |
| P2-3 | `.codebase-memory/` 两个索引产物仍在 diff 里（78KB→131KB），`.gitignore` 只有 `node_modules/` | `.gitignore` | 加 `.codebase-memory/` |

---

## 四、环境变更记录（按要求如实标注）

**rtk 在任务期间被外部替换：1.1.0 → 0.49.0。** 我实测 0.49.0 的五条关键契约（`final-fakefidelity.mjs` + 抽验）：

```
git status                 → exit 3  "rtk git status"
Get-ChildItem              → exit 1  ""
rtk git status             → exit 3  "rtk git status"（恒等）
ls -la && rtk git status   → exit 3  "rtk ls -la && rtk git status"（逐段）
git status && git diff     → exit 3  "rtk git status && rtk git diff"
-h / --help                → exit 0  吐 help（P1-1 的成因，仍成立）
有 -- 隔离时 11 条命令      → 与假 rtk 完全一致
```

与 1.1.0 完全一致，适配结论不受影响。**但需注意**：`rtk-capabilities.md` 与 `README` 里凡以「1.1.0 实测」为据的表述，严格说应在发布前复核或标注「0.49.0 / 1.1.0 双版本实测一致」。这不影响代码正确性，只影响文档可追溯性。

**建议在 review-report.md 与 verify-report.md 的头部把「本机实测版本」从 1.1.0 改为「0.49.0（任务末期）/ 1.1.0（任务前期）」。**

---

## 五、复核命令（原样可跑）

```bash
cd /d/Code/DSH-Rtk-rewrite

# 本地全量
node test.js | tail -5          # 期望 365/365 ALL PASS

# CI 环境（关键）
mkdir -p /tmp/nortk
PATH="/tmp/nortk" RTK_TEST_FAST=1 "$(which node)" test.js; echo "CI_EXIT=$?"
                                 # 期望 258/258, CI_EXIT=0

# 1. P1-3 是否真闭合（R2/R3 在 CI 环境必须变红）
node .planning/2026-11-08-rtk-upstream-sync/final-r2-ci.mjs

# 2. P0-1 是否真被锁定（用真实 return await 形态）
node .planning/2026-11-08-rtk-upstream-sync/final-p01true.mjs

# 3. 两个等价变异体的性质测试
node .planning/2026-11-08-rtk-upstream-sync/final-equivalence.mjs

# 4. 假 rtk 建模保真度
node .planning/2026-11-08-rtk-upstream-sync/final-fakefidelity.mjs

# 5. 行为探针（P0-1 / P1-1 / 字段保真 / 幂等）
node .planning/2026-11-08-rtk-upstream-sync/probe-blast.mjs
node .planning/2026-11-08-rtk-upstream-sync/probe-dash.mjs
node .planning/2026-11-08-rtk-upstream-sync/probe-edge3.mjs
node .planning/2026-11-08-rtk-upstream-sync/probe-idem.mjs
```
