# 独立代码审查报告（终版）— dsh-pwsh-rtk-rewrite 改造

审查对象：`index.js` / `test.js` / `cordis.patch.yml` / `package.json` / `.github/workflows/publish.yml` / 四份规划报告
审查基线（终版快照 15:12）：`index.js` 263 行 sha256 `9cad3b2f…`、`test.js` sha256 `84d71629…`、`publish.yml` sha256 `8af2c699…`；本地 `node test.js` **321 项全绿**（审查期间测试仍在并行扩充，项数从 247 → 306 → 321 递增，本报告所有结论已随每次扩充重跑复核）
实测环境：Windows 11 / node v26.13.0 / rtk 1.1.0 / dsh 内核 0.2.2-rc.1（上游 master fcc0ad4）
上游取证：`/d/Code/_upstream/rtk`(develop bd7f87e)、`/d/Code/_upstream/dsh`(master fcc0ad4)
可复核脚本：`.planning/2026-11-08-rtk-upstream-sync/probe-*.mjs`（21 个，全部只读）

> **审查过程声明**：本报告初版（14:55）针对 `index.js` 244 行快照，判定"修完可发布"并列出 P0-1/P1-1/P1-2/P2-1 四条。审查期间 impl-engineer 与 test-engineer 并行提交了新版本，其中 **P0-1 与 P1-1 已修好、P1-2 与 P2-1 已补上**。本终版基于 15:12 的最新快照重新取证（测试项数 247 → 306 → 321 三次扩充后均已重跑全部回退变异与行为探针），把初版结论按实际状态更新；新增一条 **P1-3（CI 配置在无 rtk 环境必然 FAIL）**，这是本次审查唯一未闭合的必修项。

---

## ① 逐维度判定表

| # | 维度 | 判定 | 一句话结论 | 关键证据 |
|---|------|------|-----------|---------|
| 1 | 契约正确性 | **通过** | 退出码 0/1/2/3 四分支与 `rewrite_cmd.rs:111-124` 逐条对应；exit 2 静默、exit 3 显式、未定义码丢弃 stdout | `probe-exitcode2.mjs`：四种形态实际执行序列全部符合上游语义 |
| 2 | 失败安全（执行失败上抛） | **通过（已修）** | `super.execute` 已移出 `try`（`index.js:247-261`），沙箱异常与取消原样上抛，命令只提交一次 | `probe-blast.mjs` 终版：A 类 `调用序列=["rtk git status"]`、`抛出=SandboxUnavailableError` |
| 2b | 失败安全（改写失败 fail-open） | **通过** | ENOENT / 超时 / exit1 / exit2 / 未定义码 / 同步抛（NUL、ENAMETOOLONG）全部执行原命令，Promise 恒 resolve | `probe-edge3.mjs`：八种异常入参 `super.execute 次数=1`，无挂起 |
| 2c | clap flag 隔离 | **通过（已修）** | `-` 开头的命令走 `['rewrite','--',cmd]`（`index.js:201`），help 文本不再被当命令 | `probe-dash.mjs` 终版：`-h`/`--help` 最终执行 = 原命令 |
| 3 | 递归防护完整性 | **有风险** | 危险方向（误判为 rtk → 跳过改写 → 丢收益）零命中；6 种真实形态漏判但均安全，**且注释已如实标注这一依赖** | `probe-new-guard.mjs` 45 例；`index.js:164-172` 注释 |
| 4 | 沙箱不降级 | **通过** | `{ ...spec }` 保留 `ShellExecSpec` 全部 9 字段；spec 由对象字面量构造（`pwsh-local:174-184`），无 getter/原型链可丢 | `probe-edge3.mjs` §C：`缺失字段: []` |
| 5 | 性能与副作用 | **通过** | 单次 rtk median **37.6ms**（n=20）；并发 10 路 64.8ms，无竞态、无僵尸 | `probe-more.mjs` |
| 6 | 测试有效性 | **有问题（P1-3）** | 321 项全绿；回退变异 R1/R2/R3 全部变红（修法已被锁定），R4 反向验证不误伤；**但 CI 配置的 `RTK_TEST_FAST=1` 在无 rtk runner 上必然 FAIL** | `probe-regress.mjs`；`probe-ci.mjs` + `PATH` 模拟复现 |
| 7 | 代码质量 | **通过** | 无死代码、无多余抽象；顶部注释与 `isRtkInvocation` 注释均与实测一致（含对自身局限的如实陈述） | `index.js:1-27`、`index.js:155-173` |
| 8 | 与 dsh 上游一致性 | **通过** | 子类化 `execute()` 仍是唯一路径（`shell/shell/src/index.ts:64-94` 只有 abstract `resolve`/`execute`）；patch 写法与上游 base 行一致（`bundle/base/cordis.patch.yml:255-257`） | 上游 shell 包 0 处 hook/emit |

---

## ② 必须修的问题

### P1-3　CI 配了 `RTK_TEST_FAST=1`，但 E1 组没有 FAST 跳过分支 → 无 rtk 的 runner 上必然 FAIL

**位置**：`.github/workflows/publish.yml:71-74` 与 `test.js` E1 组

```yaml
71      - name: Test
72        run: node test.js
73        env:
74          RTK_TEST_FAST: '1'
```

CI 注释明确写了「`RTK_TEST_FAST=1` skips the real-rtk groups (F/G)」，但 **E1 组（`-h`/`--help` 防泄露）是真 rtk 组，却没有 FAST 跳过分支**：

```js
// test.js E1 组（无 FAST 判断）
const G_E1 = 'E1. 以 - 开头的命令（P1-1）';
if (!real.available) {
  check(G_E1, '真实 rtk 可用', false, '未找到 rtk，无法验证 clap 的 -h 行为');   // ← hard FAIL
} else { ... }
```

**实测复现（模拟 GitHub ubuntu-latest，PATH 里无 rtk）**：

```bash
$ PATH="/tmp/nortk" RTK_TEST_FAST=1 "$(which node)" test.js; echo "CI_EXIT=$?"
── E1. 以 - 开头的命令（P1-1）  [0/1]
   FAIL 真实 rtk 可用
总计 214 项：通过 213 / 失败 1 / 与契约不一致 0
RESULT: FAIL
CI_EXIT=1
```

> 复现要点：`PATH` 必须换成不含 rtk 的目录（`mkdir -p /tmp/nortk`），且 `node` 用绝对路径调用 —— 否则 `PATH` 一换 node 自身也找不到（`CI_EXIT=127`）。GitHub 的 `ubuntu-latest` 预装 node 但**不含 rtk**，`setup-node` 步骤会把它放进 PATH，因此该 runner 上 `real.available === false`，E1 组必然走 hard FAIL 分支。

**后果**：这条 workflow 在 push 到 main 时会**直接失败**，`npm publish` 永不到达。它比"CI 不跑测试"更糟 —— 之前的版本会静默发布，现在会静默卡死，维护者大概率第一反应是把 Test 步骤删掉，反而丢掉整个门禁。

**修法（两条，选一）**：

方案 A（推荐，改测试）：给 E1 组加 FAST 跳过，同时用**假 rtk** 覆盖 P1-1 的正反两面 —— 可行性已验证（`probe-ci.mjs`）：

```
["-h"]              code=0 helpText=true     ← 无 -- 时泄露
["--","-h"]         code=1 helpText=false    ← 有 -- 时安全
["--","--help"]     code=1 helpText=false
["git status"]      code=3 out="rtk git status"
["--","git status"] code=3 out="rtk git status"   ← -- 不误伤正常命令
```

假 rtk 只需在现有 `test.js:65-82` 的场景里加两条分支，感知 `process.argv[3] === '--'`：

```js
else if (scenario === 'dash-noisolate') { /* 模拟 clap: 无 -- 且首参为 -h/--help 时吐 help 到 stdout，exit 0 */ }
else if (scenario === 'dash-isolate')   { /* 有 -- 时按命令处理，exit 1 或正常改写 */ }
```

方案 B（最小改动）：E1 组改成 `if (FAST) { check(G_E1, 'FAST 模式跳过真 rtk 的 clap 验证', true); } else if (!real.available) { ... }`，与 F/G 组一致。**代价**：CI 上 P1-1 完全无覆盖，退回「靠本地跑」的状态。

**严重度 P1 而非 P2**：它让发布流水线 100% 中断，且失败原因与"插件有 bug"难以区分。建议方案 A。

---

### P2-2　工作区污染（提交前必清，非代码缺陷）
**位置**：仓库根

```bash
$ git status --porcelain
 M .codebase-memory/artifact.json
 M .codebase-memory/graph.db.zst        # 索引产物 78KB → 131KB
 M .github/workflows/publish.yml
 M README.md / README_zh.md / index.js / test.js
?? .mutants/                            # 变异测试临时产物
?? .planning/2026-11-08-rtk-upstream-sync/
?? .tmp-probe/                          # teammate 的临时探针
?? mutate.js                            # 变异测试临时脚本
```

`.gitignore` 目前只有 `node_modules/` 一行。建议：

```
node_modules/
.codebase-memory/
.mutants/
.tmp-probe/
```

`mutate.js` 若确为可复用的变异工具则保留并放到 `scripts/`，否则删除。**不阻塞发布，但会把 diff 从 6 个文件撑成 8+ 个目录。**

---

## ③ 已修复项复核（初版 P0-1 / P1-1 / P1-2 / P2-1）

| 编号 | 初版判定 | 终版状态 | 复核方式 |
|---|---|---|---|
| P0-1 `try` 包住 `super.execute` | 阻塞 | **已修** `index.js:247-261` | `probe-blast.mjs`：A 类取消/confine 失败 `调用序列=["rtk git status"]`（仅一次）+ 异常原样上抛 |
| P1-1 未用 `--` 隔离 clap | 必修 | **已修** `index.js:198-201` | `probe-dash.mjs`：`-h`/`--help`/`-hh`/`-v`/`--version`/`--`/`-x ls` 最终执行全等于原命令 |
| P1-2 两条路径零测试覆盖 | 必修 | **已补** E0 组 13 项 + E1 组 33 项 | 回退变异 R1（恢复双执行）→ 变红；R2（去 `--`）→ 变红 6 项；R3（只特判 `-h`）→ 变红 4 项 |
| P2-1 CI 不跑 test.js | 必修 | **已修** `.github/workflows/publish.yml:71-74` | 但引出新问题 P1-3 |

**修法质量评价**：

- P0-1 的修法把注释写成了不变量说明（`index.js:241-246`："an AbortError from a cancelled call, or a SandboxUnavailableError from a confinement runner that never came up, must reach the caller unchanged"），比初版建议更清楚。
- P1-1 把理由写在了 `execFile` 的实参旁（`index.js:198-200`），读代码时无需跳转。
- E0 组的注释把「改写失败该吞 / 执行失败不该吞」这条区分讲透了（`test.js:578-583`），是这个套件里最有价值的一段。
- E1 组不仅断言最终执行内容，还记录了 rtk 侧事实（`rtk 侧事实：rewrite "-h"（无 -- 隔离时）exit=… 输出长度=…`），便于后续复核。

**唯一遗留**：E1 组没做 FAST 门控（P1-3）。

---

## ④ 可接受的风险

### 4-1　递归防护的 6 处漏判：安全性成立，且注释已如实标注
`probe-new-guard.mjs` 45 例矩阵中返回 `false`（会多 spawn 一次 rtk）的形态：

| 命令文本 | guard | rtk 实际返回 | 后果 |
|---|---|---|---|
| `FOO="a b" rtk git status` | false | exit 1 | 多一次 spawn，安全 |
| `sudo rtk git status` | false | exit 1 | 多一次 spawn，安全 |
| `powershell -c "rtk git status"` | false | exit 1 | 多一次 spawn，安全 |
| `rtk=1 ls` | false | exit 1 | 多一次 spawn，安全 |
| `rtk\r\ngit status` | false | `rtk\r\nrtk git status` | 多一次 spawn，**结果正确**（第二段该改写） |
| `rtk git status # ; ls` | false | `rtk git status #; rtk ls` | 多一次 spawn，**语义等价**（`#` 后全注释） |

**关键**：零条走向「误判为 rtk → 丢改写收益」，零条走向「无限增长」。`probe-idem.mjs` 幂等链 6 个种子全部 ≤2 轮收敛。

**可取之处**：`index.js:164-172` 的注释已经主动写明了这个依赖 ——

> "This is a fast path, not a complete recogniser. It does not read through a wrapper (`sudo rtk ...`, `powershell -c "rtk ..."`), a quoted env value (`FOO="a b" rtk ...`), an assignment whose name collides (`rtk=1 ls`), a CRLF line break, or a `#` comment. Those all return false and simply get rewritten once more, which is safe because rtk exits 1 on a first word it does not recognise — so safety here leans on upstream's tolerance, and it needs revisiting if rtk ever starts rewriting through `sudo`/`powershell`."

这条注释把「已知局限 + 为什么安全 + 何时需要重评」三件事都写了，是本次改造里质量最高的一段。**初版报告建议的"在注释里补一句安全性依赖上游宽容"已由实现者独立完成。**

### 4-2　`missingWarned` 单例与并发
JS 单线程，`missingWarned = true` 与 `warn()` 之间无 await，无竞态。并发 10 路 64.8ms，无僵尸。`missingWarned` 永不重置是期望行为（装上 rtk 后立刻恢复工作，只是不再重复告警）。

**小瑕疵（不修）**：`index.js:214-215` 的超时告警**没有**单次化，每次超时都 warn。属噪声而非缺陷 —— 超时是异常状态，持续告警有助于发现问题。

### 4-3　`isRtkSegment` 的 env 前缀剥离有冗余
```js
for (;;) {
  const word = firstWord(rest);
  if (!ENV_ASSIGNMENT.test(word)) break;
  rest = rest.trimStart().slice(word.length);   // 进入循环时已 trimStart，此处多余
}
```
不影响正确性，不值得为纯风格改动。

**观察（不修）**：注释示例 `FOO=1 rtk ...` / `RTK_DISABLED=1 rtk ...` 是 POSIX 语法，pwsh 不用 `VAR=val cmd` 前置形式。这是跨 shell 移植留下的痕迹，但在 pwsh 下这些命令本就不合法，走向 rtk exit 1 → 安全透传，无害。

### 4-4　真 rtk 组用同一 rtk 当 oracle
`test.js:201` 的 `realRewrite` 拿实时 rtk 输出当期望值，`expectedCommandFor`（`test.js:213`）与 `index.js` 实现同一套规则 —— 「同一逻辑写两遍」。若 rtk 行为变化，测试跟着变，不锁定历史契约。

**可接受**：`rtk-capabilities.md §5.3` 用 12 族 60+ 条固定命令清单做横向锚点，F 组对 `ls | grep foo` 有硬编码断言。完全锁定版本会牺牲对新 rtk 的兼容验证能力。

### 4-5　rtk 超时后可能留下孤儿进程
`execFile` 的 `timeout: 5000` 发 SIGTERM（`probe-failsafe2.mjs`：`errCode=null, errKilled=true, errSignal='SIGTERM'`）。Windows 上对无窗口子进程等价 TerminateProcess；rtk 在 rewrite 路径不 spawn 子进程（只读配置 + 规则匹配）。**可接受**。若将来 rtk rewrite 引入子进程需改 `taskkill /T`。

---

## ⑤ 总体结论

**修完 P1-3 即可发布。**

改造本身是实质性的质量跃升，且**初版报告指出的 1 条阻塞缺陷 + 3 条必修项已全部被实现者修好，并都用变异测试证明了修法被锁定**：

| 编号 | 状态 | 锁定证据 |
|---|---|---|
| P0-1 双执行/异常降级 | ✅ 已修 | 回退变异 R1 变红 |
| P1-1 help 文本当命令 | ✅ 已修 | 回退变异 R2 变红 6 项、R3（半修）变红 4 项 |
| P1-2 零覆盖 | ✅ 已补 | E0 组 13 项 + E1 组 33 项 |
| P2-1 CI 不跑测试 | ✅ 已修 | `publish.yml:71-74` |
| **P1-3 CI 在无 rtk 环境必然 FAIL** | ❌ **待修** | `PATH=/tmp/nortk RTK_TEST_FAST=1 node test.js` → `CI_EXIT=1` |

**放行条件**：
1. 按 ②-P1-3 的方案 A 给 E1 组加 FAST 门控（建议用假 rtk 覆盖正反两面，`probe-ci.mjs` 已证明可行）。
2. 复验命令：`PATH="/tmp/nortk" RTK_TEST_FAST=1 node test.js; echo $?` → 必须为 `0`。
3. 清理 ②-P2-2 的工作区污染后提交。

**不建议**的处理方式：
- 不要把 CI 的 `node test.js` 步骤删掉或改成 `continue-on-error` —— 那会丢掉整个门禁，而这套 321 项测试质量足够高，值得作为硬门禁。
- 不要为了让 CI 通过而设 `RTK_TEST_SOFT=1` —— 注释里已明确说明「该 flag 用于本地迭代时降级发现，CI 必须保持 strict」，这个判断是对的。

---

## 附：审查过程中证伪的三个候选问题

1. **「Promise 可能永不 resolve」** —— 不成立。`execFile` 四种终止形态（正常退出 / 非零退出 / 超时 SIGTERM / spawn 失败）都会进回调（`probe-failsafe2.mjs` 逐一实测）。同步抛路径（NUL → `ERR_INVALID_ARG_VALUE`、ENAMETOOLONG、EFTYPE、空 file）都在 Promise executor 内转成 rejection，由 `rtkRewrite` 外层 `let rewritten` 兜住。**已用 D2 组（`test.js:558-576`）覆盖。**

2. **「`JSON.stringify` 在日志里抛异常让命令失败」** —— 不成立。`index.js:256` 的输入是 `spec.command`（string，上游 `ShellExecSpec.command: string` 保证）与 `rewritten`（`String(stdout).trim()` 产物），无循环引用可能。`probe-edge3.mjs` §B 八种入参（含 object、NUL、200KB）均未触发。

3. **「`spec.command` 非字符串时 `trimStart()` 崩」** —— 初版成立、终版不成立。旧版 `spec.command.trimStart()` 在 `command=undefined` 时抛 `TypeError`；纯函数化后 `isRtkInvocation` 用 `String(command)` 兜底（`index.js:175`），`probe-edge3.mjs` §B 显示 `undefined/null/42/{a:1}` 全部走到 `super.execute` 且只调用一次。**这是改造的正向收益，记录在案。**

---

## 附：上游取证索引（供 Lead 复核）

| 结论 | 上游文件:行 |
|---|---|
| exit 0/1/2/3 四分支渲染 | `rtk/src/hooks/rewrite_cmd.rs:111-124` |
| `--help` 的「0 = 改写」是条件句，不是无条件 | `rtk/src/lib.rs:1069-1093` |
| exit 2 可能带消息（契约允许，1.1.0 未实现） | `rtk/src/lib.rs:1082-1084` |
| `Default → exit 3`（默认无规则机器） | `rtk/src/hooks/rewrite_cmd.rs:242` |
| rtk 自身递归防护窄于本插件 | `rtk/src/discover/registry.rs:836`、`:2008` |
| 复合/管道逐段改写 | `rtk/src/discover/registry.rs:1284-1397` |
| `ShellExecSpec` 字段全集（9 个） | `dsh/packages/shell/shell/src/types.ts:111-137` |
| spec 由对象字面量构造（无 getter） | `dsh/packages/shell/pwsh-local/src/index.ts:174-184` |
| `execute()` 阶段 reject 之取消路径 | `dsh/packages/shell/pwsh-local/src/index.ts:285` |
| `execute()` 阶段 reject 之 confine 失败 | `dsh/packages/shell/pwsh-local/src/index.ts:286-290` |
| `result()` 阶段 reject 之沙箱 unavailable | `dsh/packages/shell/pwsh-sandbox/src/index.ts:129` |
| `result()` 阶段 reject 之 mapError | `dsh/packages/shell/pwsh-sandbox/src/index.ts:132-139` |
| shell 无可用的 before-execute hook | `dsh/packages/shell/shell/src/index.ts:64-94` |
| 上游 base 的 pwsh-sandbox 行（对照 patch 写法） | `dsh/packages/bundle/base/cordis.patch.yml:255-257` |
| 插件兼容判定用 `semver.satisfies(…, {includePrerelease:true})` | `dsh/packages/boot/app-boot/src/plugin-compatibility.ts:51-53` |

---

## 附：复核命令清单

```bash
cd /d/Code/DSH-Rtk-rewrite

# 1. 本地全量（321 项，含真 rtk 的 F/G/E1）
node test.js | tail -8

# 2. P1-3 复现（模拟 CI：无 rtk + FAST=1）—— 当前应为 FAIL
PATH="/tmp/nortk" RTK_TEST_FAST=1 "$(which node)" test.js; echo "CI_EXIT=$?"

# 3. P0-1 修法复核（沙箱异常上抛、命令只提交一次）
node .planning/2026-11-08-rtk-upstream-sync/probe-blast.mjs

# 4. P1-1 修法复核（-h/--help 不泄露 help 文本）
node .planning/2026-11-08-rtk-upstream-sync/probe-dash.mjs

# 5. 修法是否被测试锁定（R1/R2/R3 应全红，R4 反向应红）
node .planning/2026-11-08-rtk-upstream-sync/probe-regress.mjs

# 6. 12 个变异体（应 12/12 捕获）
node .planning/2026-11-08-rtk-upstream-sync/probe-mutation-real.mjs

# 7. 递归防护 45 例 + 幂等链
node .planning/2026-11-08-rtk-upstream-sync/probe-new-guard.mjs
node .planning/2026-11-08-rtk-upstream-sync/probe-idem.mjs

# 8. 假 rtk 覆盖 P1-1 的可行性（P1-3 方案 A 预研）
node .planning/2026-11-08-rtk-upstream-sync/probe-ci.mjs
```
