# dsh 上游插件与 shell provider 契约调研

- 调研人：dsh-researcher
- 时间：2026-11-08
- 上游只读副本：`/d/Code/_upstream/dsh`，`master`，HEAD `fcc0ad4`，`.git/shallow` 仅含该 commit（**浅克隆，`git log` 无历史**）
- 上游版本：根 `package.json` `version: 0.2.2-rc.1`（`/d/Code/_upstream/dsh/package.json:3`）
- 本机桌面端内核：`0.2.1-rc.5`
- **取证方式说明**：本会话 `ops_bash` 运行时不可用（`EXECUTOR_UNAVAILABLE: Niubash execution tree link count mismatch`，两次尝试均失败，属宿主机环境问题而非权限拒绝）。因此 `git log` / `git diff` 类历史对比**无法在本会话执行**。0.2.1-rc.x 侧的对照证据改用 `raw.githubusercontent.com` 按 tag 直链读取源码（`dsh-v0.2.1-rc.3`、`dsh-v0.2.1-rc.5` 均 HTTP 200），与本地 `master` 逐行比对。标注：**[亲验·本地]** = 读本地上游文件；**[亲验·raw]** = 按 tag 拉上游 raw 源码；**[推断]** = 由证据推导。
- 每条结论附 `文件:行号`。

---

## 0. 结论（先给答案）

**① 子类化做法仍然合规。** `SandboxPwshExecutor` 在 0.2.2-rc.1 中**没有被禁止继承**，`execute(spec)` 仍是 `ShellExecutor` 的抽象契约方法，`ShellExecSpec` 的字段集与 0.2.1-rc.5 完全一致。`docs/subsystems/shell.md` 的官方措辞依然是「Subclass, implement the abstract methods, and load the subclass as a plugin」——**"继承 `SandboxPwshExecutor` 覆盖 `execute`" 不是野路子，它就是文档指明的路径**，只不过文档指向的是继承 `ShellExecutor`；继承更具体的 `SandboxPwshExecutor` 则额外承接了沙箱语义（见 ③）。

**② spec 字段无变化。** `ShellExecSpec` 在 0.2.1-rc.5 与 0.2.2-rc.1 之间逐字段相同（10 个字段，见 ①表）。现插件的 `{ ...spec, command: rewritten }` 展开写法**不会丢字段**，也**不需要补字段**。

**③ 没有比子类化更正统的扩展点。** 本会话穷举了四个候选，全部排除：
- `tools/pre-execute` 无法改写输入——契约类型注释明文写着「Input rewriting is excluded because arguments are already logged and presented」。
- `tools/execute` 只允许改 `exec.signal`，且 `ToolExecution.arguments` 是 `readonly` 且已深度冻结。
- Claude Code / Codex hook 桥的 `updatedInput` 字段**已被明确标注「PARSED but NOT honored — input rewrite is deferred」**。
- `ctx.shellEnv` 只贡献 `DSH_*` 环境变量，不是命令改写点。

**结论：继承 `SandboxPwshExecutor` 覆盖 `execute` 就是当前唯一可用的命令级改写点，且是文档允许的做法。不需要重构。**

**④ 一句话**：现行实现仍合规、spec 无变化、无更正统扩展点；需要动的只有 package.json 的 peer 范围与 devDependency 版本对齐（见 ⑦）。

---

## ① pwsh-sandbox 执行器 API 现状

### 1.1 继承链与导出

```
ShellExecutor (abstract, ctx.shell 注册者)      packages/shell/shell/src/index.ts:64
  └─ PwshLocalExecutor                          packages/shell/pwsh-local/src/index.ts:123
       └─ SandboxPwshExecutor                   packages/shell/pwsh-sandbox/src/index.ts:52
```

| 包 | 职责 | 导出 | 证据 |
|---|---|---|---|
| `shell` | 定义 `ctx.shell` 抽象 seam：`resolve` / `execute` / `sandboxMode`；类型词汇 | `ShellExecutor`, 全部类型, `parseExitStatus` | `packages/shell/shell/src/index.ts:13-28,64-94` |
| `pwsh-local` | 本地 pwsh 执行：`pwsh -NoLogo -NoProfile -NonInteractive -Command <cmd>`，超时/输出/编码/后台读取 | `PwshLocalExecutor`, `ENV_OVERRIDES`, `ENCODING_PREAMBLE`, `Config`, `assertServiceablePwshConfig`, `candidatePwshPaths`, `resolvePwshPath` | `packages/shell/pwsh-local/src/index.ts:34-49,58-78,82,107,123` |
| `pwsh-sandbox` | 经 `ctx.sandbox.confine()` 包装 pwsh argv，标注 mode/enforcement/denial 事实 | `SandboxPwshExecutor`（default 也是它）, `Config`(=LocalConfig) | `packages/shell/pwsh-sandbox/src/index.ts:40,52,200` |
| `shell-env` | `ctx.shellEnv` 注册表，为每次执行收集 `DSH_*` 快照 | `ShellEnvRegistry.register/collect/list` | `docs/subsystems/shell.md:284-309` |
| `bash-local` / `bash-sandbox` | POSIX 对应物，`SandboxPwshExecutor` 的 call-for-call 镜像 | 同构 | `packages/shell/pwsh-sandbox/src/index.ts:51`（`jscpd:ignore-start` 注释标明是 bash-sandbox 的刻意镜像） |
| `tool-bash` / `tool-pwsh` | 模型侧工具，消费 `ctx.shell` | — | `packages/shell/tool-pwsh/src/index.ts:217-226,293,531-550` |

**关键：`SandboxPwshExecutor` 的 `execute` 是 `override`（具名可覆盖），不是 `final`/私有。** `packages/shell/pwsh-sandbox/src/index.ts:96`：

```ts
override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
```

### 1.2 `resolve(request)` 签名与产出

`SandboxPwshExecutor.resolve` 在 `PwshLocalExecutor.resolve` 之上**只加一个字段**（`packages/shell/pwsh-sandbox/src/index.ts:92-94`）：

```ts
override resolve(request: ShellExecRequest): ShellExecSpec {
  return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
}
```

父类 `resolve`（`packages/shell/pwsh-local/src/index.ts:163-185`）负责补 `workdir`、`clampTimeout` 出 `timeoutMs`、`onExpiry`、`stdoutMaxBytes`，并把 `signal`/`stdin`/`env`/`dshEnv` 按「有值才展开」的方式带过去。

### 1.3 `ShellExecSpec` 字段全集（这是实现者的关键清单）

来源：`packages/shell/shell/src/types.ts:111-137`。**与 0.2.1-rc.5 逐字段一致**（[亲验·raw] `dsh-v0.2.1-rc.5/packages/shell/shell/src/types.ts` 的 `interface ShellExecSpec` 同名同序同可空性）。

| # | 字段 | 类型 | 含义 | 改写时可否动 | 0.2.1→0.2.2 |
|---|---|---|---|---|---|
| 1 | `command` | `string` | 要执行的命令文本（**本插件唯一要改的字段**） | **可改**（这正是插件目的） | 未变 |
| 2 | `workdir` | `string`（必填） | 已解析的绝对工作目录；沙箱 `workspace-write` 的 cwd 依据 | 不可改（改它会改变沙箱归属与 `isRunnerSpawnFailure` 的 cwd 判定） | 未变 |
| 3 | `timeoutMs` | `number`（必填） | 已 clamp 的截止时间；`onExpiry:'none'` 时只回显不计时 | 不可改（改写不应改变执行预算） | 未变 |
| 4 | `onExpiry` | `'kill' \| 'none'` | 到期策略 | 不可改 | 未变 |
| 5 | `stdoutMaxBytes` | `number`（必填） | 前台 stdout 捕获预算（可信插件输入，模型工具不暴露） | 不可改 | 未变 |
| 6 | `signal` | `AbortSignal \| undefined` | 调用方取消信号；已 abort 视为已触发 | 不可改（`SandboxPwshExecutor` 会读 `spec.signal?.aborted` 做取消归因，`.../index.ts:134`） | 未变 |
| 7 | `stdin` | `string \| undefined` | 先写入再关闭的 stdin 字节（hooks 桥用） | 不可改 | 未变 |
| 8 | `env` | `Record<string,string> \| undefined` | 普通环境变量，在凭据清洗后合并；`dshEnv` 在其后再合并 | 不可改 | 未变 |
| 9 | `dshEnv` | `DshEnvironment \| undefined` | Harness 拥有的 `DSH_*` 快照，最后合并，`env` 不可顶掉 | 不可改 | 未变 |
| 10 | `sandboxPolicy` | `SandboxExecutionPolicy \| undefined` | **本次调用的沙箱策略**（`mode` + `workspaceRoot` + 可选 `additionalWritableRoots`/`sessionId`） | 不可改（丢它 = 沙箱降级） | 未变 |

**`sandboxPolicy` 的结构**（`packages/sandbox/sandbox/src/index.ts:40-60`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `'read-only' \| 'workspace-write' \| 'danger-full-access'` | 文件效果模式（`sandbox/src/index.ts:30`） |
| `workspaceRoot` | `string` | `workspace-write` 可写的绝对根；即使其它模式不消费也必带 |
| `additionalWritableRoots?` | `readonly string[]` | 额外可写绝对目录；`read-only`/`danger-full-access` 下不授予任何权限 |
| `sessionId?` | `SessionId` | 会话身份；Windows ACL 后端据此给每个 session/workspace 对分配随机私有 temp 目录与 SID |

**`SandboxPolicy`** 是 `SandboxExecutionPolicy` 且 `mode: ConfinedSandboxMode`（即排除 `danger-full-access`），`packages/sandbox/sandbox/src/index.ts:77-80`。

### 1.4 `execute(spec)` 的分支与返回

`packages/shell/pwsh-sandbox/src/index.ts:96-140`：

| 分支 | 条件 | 行为 |
|---|---|---|
| 免沙箱 | `policy.mode === 'danger-full-access'`（L99） | 直接 `super.execute(spec)`，不碰 provider，结果补 `sandbox:{mode, denied:false}`（L100-103） |
| 受限 | 其余（L105起） | 走 `executeArgv(spec, prepare, onStarted)`：`prepare` 里 `ctx.sandbox.confine(this.argv(spec), policy, signal)`（L107, L194-196），`argv()` 由父类生成 |
| 结算 | `decorateResult`（L122-139） | runner 失败优先于 denial，抛 `SandboxUnavailableError`；否则补 `sandbox:{mode, denied, enforcement}` |
| 无 confined | `confined === undefined`（L123） | 补 `sandbox:{mode, denied:false}` |

**返回类型 `ShellExecution extends ShellProcess`**（`packages/shell/shell/src/types.ts:226-238`）= 活进程句柄 + `result(): Promise<ShellRunResult>` 前台投影。`ShellProcess` 字段：`status`/`exitCode`/`signal`/`done`/`sandbox?`/`readOutput()`/`observed`/`kill()`（L188-220）。`ShellRunResult`：`exitCode`/`signal`/`timedOut`/`aborted`/`timeoutMs`/`stdout`/`stderr`/`sandbox?`（L140-165）。

**对本插件的直接含义**：只要 `execute` 仍然 `return super.execute({...spec, command})` 并返回父类给的句柄，`decorateResult` 的 memoize 逻辑（L147-159，`ex.result` 原地改写、句柄身份不变）就仍然成立——**注释里"handle keeps its identity... because per-process facts and onProcessDone key on the exact instance"（L144-146）是对实现者的直接警告：不要包一层新对象返回**。

---

## ② 官方推荐扩展点排序

### 2.1 候选穷举与逐项证伪

| 候选扩展点 | 位置 | 能否改写命令 | 判定依据 |
|---|---|---|---|
| **A. 继承 `ShellExecutor` / `SandboxPwshExecutor` 覆盖 `execute`** | `packages/shell/shell/src/index.ts:64-94`；`docs/subsystems/shell.md:249` | **能** | 文档原文：「Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.shell`（one implementation per context; loading a second throws）」`docs/subsystems/shell.md:249`；同文 `packages/shell/shell/src/index.ts:36-40` |
| B. `tools/pre-execute` waterfall | `packages/core/tools/src/events.ts:18` | **不能** | 契约注释明文：「**Input rewriting is excluded because arguments are already logged and presented.**」`packages/core/tools/src/contracts.ts:348-356`（`PreToolDecision` 的文档）。`PreToolDecision` 只有 `allow`/`deny`/`cancel`/`ask` 四态，无 replace/edit 态（L357-361） |
| C. `tools/execute` waterfall | `packages/core/tools/src/events.ts:29` | **不能** | 「wrappers may change **only** `exec.signal`, while call identity remains immutable」`events.ts:20-28` |
| D. Claude Code / Codex hook 桥 | `packages/experimental/hook-protocol/src/types.ts:132-136` | **不能（被显式 defer）** | `updatedInput?: Record<string, unknown>` 的注释：「A tool-input rewrite a hook requested (CC `updatedInput`). **PARSED but NOT honored — input rewrite is deferred**」；hook 决策只有 `approve/allow/block/deny/ask`（`types.ts:119`） |
| E. `ctx.shellEnv` | `docs/subsystems/shell.md:284-309` | **不能** | 只注册 `DSH_*` 环境事实，`collect()` 产环境 overlay，不碰 `command` |
| F. monotonic `ToolGuard` | `packages/core/tools/src/contracts.ts:383-391` | **不能** | 返回 `string \| undefined`，只能 deny/abstain，「listener ordering cannot turn a denial back into permission」 |
| G. `ctx.sandbox.confine` 层 | `packages/sandbox/sandbox/src/index.ts:192` | 不该 | `confine(argv, policy, signal)` 只能包 argv，不能改 `command` 语义；这层属于沙箱 provider，另起实现会破坏记账 |
| H. `tools/post-execute` | `packages/core/tools/src/events.ts:41` | 不能 | 命令已执行完才触发 |

### 2.2 排序结论

| 优先级 | 方案 | 理由 |
|---|---|---|
| **首选（=现行做法）** | 继承 `SandboxPwshExecutor` 覆盖 `execute(spec)`，`{...spec, command: rewritten}` 交回 `super.execute` | ①官方文档指明的唯一 seam（`shell.md:249`）；②唯一能在「命令真正执行前」改 `command` 且不破坏 `sandboxPolicy`/`onProcessDone` 记账的位置；③`execute` 是 `override` 而非 final（`pwsh-sandbox/src/index.ts:96`）；④`executeArgv` 的 JSDoc 明说「Subclasses use this after replacing the public command's shell argv at an execution boundary」（`pwsh-local/src/index.ts:235-238`）——**这就是官方给子类的改写点说明** |
| 次选（可行但更重） | 继承 `ShellExecutor` 从零实现 | 文档字面指向它（`shell.md:249`），但要自己重写 pwsh 进程机械、超时分类、编码前导、沙箱包装——与 `ponytail` 阶梯冲突，且丢失 `SandboxPwshExecutor` 已实现的 `runnerFailed`/`denied` 归因（`helpers.ts:42-119`） |
| 兜底 | 在工具层（`tool-pwsh`）前置改写 | 需要替换 `tool-pwsh` 本身，等于重写模型工具，成本远高，且不覆盖 hooks 桥等其它 `ctx.shell` 消费者 |

**明确否证"存在更正统 hook"**：`grep -rn "before.*exec|transformCommand|rewrite.*command|middleware"` 在 `packages/shell` 下**零命中**（[亲验·本地] 179 文件扫描，`skippedFiles:126` 为 pattern 过滤，即无匹配）。`packages/shell/**` 里没有任何命令变换 hook。

### 2.3 若要更"文档化"一点，可选增强（非必须）

`SandboxPwshExecutor` 暴露了三个 `protected` 改写点，其中 `executeArgv` 的 JSDoc 明确是为子类改写预留的（`pwsh-local/src/index.ts:235-243`）：

| 改写点 | 签名 | 是否适合本插件 |
|---|---|---|
| `execute(spec)` | `override async execute(spec)` | **当前采用，合适**——spec 层能看到原始 `command` |
| `argv(spec)` | `protected argv(spec): string[]`（`pwsh-local/src/index.ts:193-195`） | 不合适：此处 `command` 已被拼上 `ENCODING_PREAMBLE`（L194），拿到的不是裸命令；且要改 argv 数组而非 spec |
| `executeArgv(spec, argvOrPrepare, onStarted)` | `protected`（`pwsh-local/src/index.ts:245-249`） | 可选但更复杂：适合改 argv 而非改 `spec.command`，对 `rtk rewrite` 这种「输入是命令文本」的场景反而绕远 |

**提示**：`index.js:12-14` 那段注释说「UTF-8 输出前导是在 PwshLocalExecutor 的 spawnSpec 层拼的，所以这里看到的 spec.command 是裸命令」——**这条结论正确且仍成立**，证据是 `argv()` 里 `${ENCODING_PREAMBLE}${spec.command}`（`pwsh-local/src/index.ts:194`），前导确实只在 argv 层拼，`spec.command` 始终是裸的。

---

## ③ 沙箱策略传递正确性结论

**结论：现插件 `{ ...spec, command: rewritten }` 传回 `super.execute`，沙箱策略与记账完全正确。逐字段验证如下。**

### 3.1 策略来源链（改写不会断开任何一环）

1. 工具层解析：`tool-pwsh` 在 `apply()` 里读 `ctx.shell.sandboxMode`（`tool-pwsh/src/index.ts:217`），并从 `ctx.sandboxPolicy.resolve({session})` 得到本次调用的 `SandboxExecutionPolicy`（L225-226）。
2. 工具层 `resolve`：`ctx.shell.resolve({ ...request, signal: exec.signal })`（L549），进入 `SandboxPwshExecutor.resolve`，把 `sandboxPolicy` 钉进 spec（`pwsh-sandbox/src/index.ts:93`）。
3. 工具层 `execute`：`ctx.shell.execute(spec)`（L550）——**到这里就是本插件的入口**。
4. 本插件 `{...spec, command}` → `super.execute`：`policy = spec.sandboxPolicy`（L97）、`mode = policy.mode`（L98）**照常生效**。

### 3.2 三条不变量在改写后仍成立

| 不变量 | 依据 | 改写后是否仍成立 |
|---|---|---|
| **fail closed**：受限模式无可用 runner 必须 `SANDBOX_UNAVAILABLE`，绝不静默非受限执行 | `pwsh-sandbox/README.md:94`；实现 `pwsh-sandbox/src/index.ts:127-131`、`135-138` | 成立——失败归因读 `confined.argv[0]` 与 `spec.workdir`，本插件不改这两个 |
| **per-process facts**：confinement 事实按句柄保留到结算 | `pwsh-sandbox/src/index.ts:66-73`；README `:96` | 成立——`processFacts` 以 `ShellExecution` 实例为 key（L113），本插件直接返回 `super.execute()` 的句柄，实例身份未变 |
| **decorateResult 句柄身份**：不得包第二层对象 | `pwsh-sandbox/src/index.ts:144-159` 注释与实现 | 成立——`return await super.execute({...spec, command})` 原样返回 |
| **deny-only at the seam**：执行器不授予权限 | README `:95` | 成立——本插件不碰 `mode`/`approval` |

### 3.3 改写对"沙箱判定输入"的影响（唯一实质性注意点）

沙箱判定只看 **argv 与 policy**，不看命令语义。改 `command` 会改变 argv 的最后一个元素（`argv()` 组装 `[pwsh, -NoLogo, -NoProfile, -NonInteractive, -Command, PREAMBLE+command]`，`pwsh-local/src/index.ts:193-195`），从而改变**实际执行的内容**——但：

- `runnerProgram = facts.argv[0]`（`pwsh-sandbox/src/index.ts:118`）取的是 provider 返回 argv 的第 0 元素（即 ACL runner 或 pwsh），**不受命令文本影响**。
- `isRunnerSpawnFailure(error, runnerProgram, spec.workdir)`（`helpers.ts:42-56`）判 `code ∈ {EACCES, ENOENT}` + `path === runnerProgram` + `syscall === 'spawn'`，也与命令文本无关。
- `denialSignatures` / `runnerFailureRules` 来自 provider 的 `ConfinedArgv`，同样与命令文本无关。

**唯一语义变化（设计如此，非缺陷）**：改写后的命令若与原文行为的文件效果不同，沙箱按**改写后**命令的实际效果判定（因为 confine 包的是改写后的 argv）。对本插件（rtk 只做命令等价变换、语义应收敛）这是期望行为；但**实现者不应在改写中引入新的文件访问路径**。

### 3.4 需要实现者注意的两个边界

| 边界 | 说明 | 证据 |
|---|---|---|
| `danger-full-access` 分支不读 `workdir` 之外的任何东西 | 该分支不走 confine，直接 `super.execute` | `pwsh-sandbox/src/index.ts:99-104` |
| 改写不得依赖 `spec.dshEnv` | `dshEnv` 是 `DSH_*` 快照，在 spawnSpec 里最后合并（`pwsh-local/src/index.ts:216`），本插件读不到"已有 dshEnv 内容"以外的信息，也不应写 | `pwsh-local/src/index.ts:216`；`shell.md:11` |

---

## ④ cordis.patch 权威规则

### 4.1 权威实现位置

patch 算法**不在 dsh 仓库的 `packages/`，而在 `vendor/include`**（即 `@deepseek-ai/cordis-plugin-include`）：

| 文件 | 角色 |
|---|---|
| `vendor/include/src/patch.ts:5-16` | `PatchOptions` 接口定义（权威类型） |
| `vendor/include/src/patch.ts:47-109` | `applyPatches`（导出别名 `applyEntryPatches`，见 `index.ts:12`）——**唯一的应用算法** |
| `vendor/include/src/patch.ts:141-184` | `PatchIndex`：`insert` 归属 vs `id` 键归属 |
| `vendor/include/src/index.ts:16-25` | `!!js` YAML tag → `{ __jsExpr: data }`；`entryListSchema` |
| `packages/boot/app-boot/src/index.ts:516-525` | `loadOptionalPatches`（profile 层 `cordis.patch.yml`） |
| `packages/boot/app-boot/src/index.ts:536-544` | `loadOverlayPatches`（bundle 的 `cordis.patch.yml` 与 `--patch`） |
| `packages/boot/app-boot/src/index.ts:571-589` | `parsePatchList`：顶层必须是 YAML 数组，否则 boot 直接抛错 |
| `packages/boot/app-boot/src/profile-context.ts:74-85` | **层叠顺序**：bundle patches → 本 profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → launch overlays → telemetry patch |

### 4.2 `PatchOptions` 字段（`vendor/include/src/patch.ts:5-16`）

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

### 4.3 `- id: xxx` 覆盖语义（`patch.ts:86-106`）

- `id` 必填（非 insert 补丁），否则 `warn('patch: id is required for non-insert patches')` 并 `continue`（L86-89）。
- 按 `entryMap` 找目标，**含 group 内子项**（`buildMap` 递归，L52-60）；找不到 → `warn('patch: entry %C not found')` + `continue`（L91-95）。**这是 warning，不是 fatal**（见 `app-boot/src/index.ts:561-564` 注释：「a single patch whose target row is absent stays a per-entry Loader warning」）。
- `name` 若给出且与目标 `name` 不符 → `warn('patch: name mismatch … skipping')` + `continue`（L97-100）。**这是防误打的保险**。
- 其余键**逐个赋值为 target[key] = value**（L102-105）——即**字段级覆盖/新增，不是整行替换**。现有 `disabled: true` 只改 `disabled` 一个键。

### 4.4 `- insert:` 语义（`patch.ts:65-84`）

| 形式 | 行为 |
|---|---|
| `{ insert: [...] }`（无 `id`） | `data.push(...structuredClone(insert))` —— **追加到顶层数组末尾**（L79-81） |
| `{ id: '<group>', insert: [...] }` | 目标必须是 group（`target.group` 为真），否则 `warn('entry %C is not a group')`；然后 `target.config.push(...clone)`（L67-78） |
| 每个 insert 项必须有 `id` | `ensureInsertIds` 为缺失者发随机 id（L36-41），因为「Runtime changes are routed back to an inserted entry by its id」 |

**关键：`insert` 不检查"是否已有同 id 的服务实现"。** 它只做数组 append。所以「一个 ctx.shell 只能有一个实现」的约束**不由 patch 层保证，而由 cordis 的 service 注册保证**——`ShellExecutor` 构造时 `super(ctx, 'shell')`（`packages/shell/shell/src/index.ts:65-67`），第二个注册抛错。

### 4.5 "一个 `ctx.shell` 实现"约束在 0.2.2-rc.1 是否仍成立

**成立，且三处独立证据一致：**

1. `packages/shell/shell/src/index.ts:36-40`：「Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.shell`（**one implementation per context; loading a second throws**, which is cordis' standard duplicate-service behavior）」——**0.2.1-rc.5 同文同句**（[亲验·raw]）。
2. `packages/shell/README.md:12`：「**Exactly one executor implementation is mounted per composition**」；`:38`「A profile layer selects exactly one executor implementation (the win32 layer swaps the POSIX rows for the pwsh ones; **mounting two fails loudly at load time on the duplicate service registration**)」。
3. `docs/subsystems/shell.md:249` 同句。

**因此 `cordis.patch.yml` 的现有做法（先 `- id: pwsh-sandbox / disabled: true`，再 `- insert:` 自己的行）在语义上仍是唯一正确写法**——顺序上先禁用后插入，不会产生瞬时双实现（patch 是同一批 `applyEntryPatches` 一次性作用在 clone 上，`patch.ts:47-48`）。

### 4.6 `disabled: !!js ...` 的求值时机

- YAML 侧：`!!js` 被构造成 `{ __jsExpr: '源码字符串' }`（`vendor/include/src/index.ts:16-21`）。
- 装载侧：`enabledEntry` 求值，**表达式抛异常视为 disabled**（`app-boot/src/index.ts:487-495`）。
- 现有 `disabled: !!js process.platform !== 'win32'`（本插件 `cordis.patch.yml:15`）与 base 行 `disabled: !!js process.platform !== 'win32'`（`packages/bundle/base/cordis.patch.yml:257`）**完全同构**，是镜像 base 行的正确写法。

### 4.7 base bundle 的 pwsh 行（本插件 id-target 的宿主）

`packages/bundle/base/cordis.patch.yml:255-257`（[亲验·本地]，与 0.2.1 相同位置）：

```yaml
    - id: pwsh-sandbox
      name: '@deepseek-ai/dsh-pwsh-sandbox'
      disabled: !!js process.platform !== 'win32'
```

**注意层级**：该行在 `config:`（`cordis:group`）的**嵌套列表**里（缩进 4 空格），不是顶层数组。本插件的补丁行是顶层（无缩进）。`buildMap` 递归建索引（`patch.ts:52-60`），所以顶层补丁能命中嵌套行的 `id`——**现行写法正确**。

---

## ⑤ package.json 契约

### 5.1 `dsh.bundle.patch`

**权威读取**：`packages/boot/app-boot/src/profile.ts:54-71`。

```ts
export function bundlePatchFiles(bundle: DshBundleManifest): string[] {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!Array.isArray(declared) || !declared.every(file => typeof file === 'string')) {
    throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
  }
  return declared
}
```

| 规则 | 值 | 证据 |
|---|---|---|
| 类型 | `string` 或 `string[]`；数组表示**按序应用** | `profile.ts:54-60` |
| 路径基准 | **包目录**（`join(packageDir, file)`） | `profile.ts:69-71` |
| 非法值 | **抛错**（`dsh.bundle.patch must be a file path or a list of file paths`） | `profile.ts:56-58` |
| 文件缺失 | bundle 被 skip，记入 `skippedBundles` 并带原因 | `profile.ts:101-107`、`loadOverlayPatches` 缺失即抛（`index.ts:536-543`） |

本插件 `package.json:40-44` 的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` **完全合规**。

### 5.2 peerDependencies 版本判定语义（**这是最需要修正认知的一条**）

**权威实现**：`packages/boot/app-boot/src/plugin-compatibility.ts`（0.2.2-rc.1，117 行）。

**关键：被比的是"内核运行时版本"，不是 peer 包自身版本。**

| 事实 | 代码 | 行号 |
|---|---|---|
| 运行时版本 = `app-boot` 自身 `package.json` 的 `version` | `getDshRuntimeVersion()` 读 `new URL('../package.json', import.meta.url)` | `plugin-compatibility.ts:44-49` |
| 满足判定用 `includePrerelease: true`；**空 range 视为不满足** | `return range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })` | `plugin-compatibility.ts:51-53` |
| `engines.dsh` **独占判定**：一旦声明，peerDependencies 全部忽略 | `if (Object.hasOwn(engines, 'dsh')) { ... return satisfied ? {} : {'engines.dsh': range} }` | `plugin-compatibility.ts:56-61` |
| 否则只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀的 peer | `if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue` | `plugin-compatibility.ts:69` |
| `workspace:^` / `workspace:~` / `workspace:*` 三种写法**被替换成当前 runtimeVersion**（即恒满足） | `const requirement = ['workspace:^', ...].includes(range) ? runtimeVersion : range` | `plugin-compatibility.ts:70` |
| 未满足时取 `name@version` 作豁免键，比对精确 runtime 版本 | `const key = ${name}@${version}`；`exempted = exemptedVersions?.includes(runtimeVersion)` | `plugin-compatibility.ts:98-100` |
| manifest 的 `name`/`version` 非空字符串是硬要求（否则抛错） | `identityField()` | `plugin-compatibility.ts:31-37` |

**→ 现插件 `peerDependencies['@deepseek-ai/dsh-pwsh-sandbox']` 会被拿去和 `dsh` 内核版本比，不是和 `dsh-pwsh-sandbox` 的版本比。** 这条语义 0.2.1-rc.3 与 0.2.2-rc.1 **完全相同**（既有历史报告 `.planning/2026-10-24-dsh-0.2.1-rc.3/upstream-report.md:86-91` 已亲验 rc.3 的同一函数；本会话复核 0.2.2-rc.1 的 117 行实现，L51-53/L56-61/L69/L70 全部一致）。

现插件范围（`package.json:33`）：

```
>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || 0.1.7-rc.2 || >=0.2.0-rc.1 <0.3.0-0
```

| 目标 runtime 版本 | `includePrerelease:true` 下是否满足 | 依据 |
|---|---|---|
| `0.2.1-rc.5`（本机现状） | 是 | 命中 `>=0.2.0-rc.1 <0.3.0-0` |
| `0.2.2-rc.1`（上游 HEAD） | 是 | 同上子范围；`0.2.2-rc.1 < 0.3.0-0` 成立 |
| `0.3.0-0` / `0.3.0` | 否 | 上界 `-0` 排他 |

**→ peer 范围当前已覆盖 0.2.2-rc.1，功能上无需改。**（`test.js:110-123` 已把这条语义写成断言，含"默认 semver 会漏判预发布"的反向用例，与上游 L52 完全对齐——**该测试有效**。）

### 5.3 `files` 白名单

上游自身的发布约定见 `packages/shell/pwsh-sandbox/package.json:25-29`（`lib/index.js` + `lib/types/**/*.d.ts` + `locale/*.json`）。本插件是**纯 ESM 源码包、无构建**，`files: ["index.js","cordis.patch.yml","README.md","README_zh.md"]`（`package.json:9-14`）符合"发布即所得"。**dsh 侧不对插件 `files` 做额外校验**——`plugin-compatibility.ts` 只读 manifest 字段（`name`/`version`/`engines`/`peerDependencies`），不检查 `files`。**风险点**：`cordis.patch.yml` 必须在 `files` 里，否则安装后补丁文件不存在 → bundle 被 skip（`profile.ts:101-107`）。**现已包含，正确。**

### 5.4 bundle id 与包名一致性

**上游代码不强制 bundle id 等于包名。** `dsh.profile.bundles` 是**包名**数组（`profile-plugins.ts:67`：`manifest.dsh?.profile?.bundles ?? []`，与依赖 `name` 直接 `includes` 比对，L74 `enabled: bundles.includes(name)`）。而**补丁里的 `id`** 是 cordis 装载器的行标识，与包名无关。

**因此本插件的正确关系是：**
- `dsh.profile.bundles` 里放 `dsh-pwsh-rtk-rewrite`（包名）→ 由安装流程自动写入（`profile-plugins.ts:115-124`）。
- `cordis.patch.yml` 里 insert 行的 `id: rtk-pwsh-shell`（**任意唯一 id**）+ `name: dsh-pwsh-rtk-rewrite`（**这才是包名解析的依据**，`patch.ts:97-100` 的 name 匹配与 loader 的 module 解析都用它）。

**现插件 `cordis.patch.yml:12-14` 的 `id`/`name` 搭配正确**：`id` 自定义、`name` = 包名。

---

## ⑥ 0.2.1 → 0.2.2-rc.1 的 shell/sandbox breaking 清单

### 6.1 取证限制（必须如实说明）

`/d/Code/_upstream/dsh` 是 `--depth 1` 浅克隆（`.git/shallow` 仅 `fcc0ad46…`），**`git log`/`git diff` 无法跨版本**；仓库内**没有根 CHANGELOG，也没有 `packages/*/CHANGELOG.md`**（`glob CHANGELOG*.md` 在 `packages/shell/**` 下零命中）。`ops_bash` 运行时不可用，无法临时 `git fetch --depth 1` 补历史。

**采用的替代取证**：按 tag 从 `raw.githubusercontent.com` 直链读 0.2.1-rc.5 的对应源文件，与本地 master（0.2.2-rc.1）逐行比对。

### 6.2 逐文件比对结果

| 文件 | 0.2.1-rc.5 vs 0.2.2-rc.1 | 判定 |
|---|---|---|
| `packages/shell/shell/src/types.ts` | `ShellExecRequest` / `ShellExecSpec` / `ShellRunResult` / `ShellProcess` / `ShellExecution` / `ShellSandboxInfo` / `ShellExpiryPolicy` 全部**同字段、同可空性、同注释** | **无 breaking** [亲验·raw + 亲验·本地] |
| `packages/shell/shell/src/index.ts` | `ShellExecutor` 抽象面（`resolve`/`execute`/`sandboxMode`）、"one implementation per context" 措辞、"Implementations must honor these semantics" 五条，**逐字相同** | **无 breaking** [亲验·raw + 亲验·本地] |
| `packages/shell/pwsh-local/src/index.ts` | `Config` 七字段（`cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/`graceMs`/`pwshPath`）、`resolve` 逻辑、`argv()`（含 `ENCODING_PREAMBLE`）、`spawnSpec`、`executeArgv`（含 `onStarted`、`Promise.withResolvers`、`onProcessDone` 四参）、`ENV_OVERRIDES` **全部一致** | **无 breaking** [亲验·raw + 亲验·本地] |
| `packages/shell/pwsh-sandbox/src/index.ts` | `execute` 三分支（`danger-full-access` / confined / `confined===undefined`）、`decorateResult` memoize、`onProcessDone` 四参重写、`confine` 私有、`processFacts` 的 6 个字段，**逐行相同** | **无 breaking** [亲验·raw + 亲验·本地] |
| `packages/sandbox/sandbox/src/index.ts` | `SandboxMode`/`ConfinedSandboxMode`/`SandboxExecutionPolicy`（含 `additionalWritableRoots`、`sessionId`）/`SandboxPolicy`/`RunnerFailureRule`/`SandboxEnforcement` 同构 | **无 breaking**（`packages/sandbox/sandbox/src/index.ts:30-96`） |
| `packages/bundle/base/cordis.patch.yml` | pwsh 行仍为 `- id: pwsh-sandbox` / `name: '@deepseek-ai/dsh-pwsh-sandbox'` / `disabled: !!js process.platform !== 'win32'`，位置 `:255-257`；与 0.2.1 同 | **无 breaking**（id-target 仍有效） |
| `packages/boot/app-boot/src/plugin-compatibility.ts` | `satisfies` 的 `includePrerelease:true`（L52）、`engines.dsh` 独占（L56-61）、`@deepseek-ai/dsh-*` 前缀过滤（L69）、`workspace:*` 替换（L70）**语义不变** | **无 breaking**（对照历史报告 rc.3 已亲验，本会话复核 0.2.2-rc.1 现行实现） |
| `packages/core/tools/src/contracts.ts` | `ToolExecutionInput.arguments: readonly unknown`（L185）、`ToolDispatchExecution` 只放开 `signal`（L231-234）、`PreToolDecision` 四态 + "Input rewriting is excluded"（L348-361）、`ToolGuard`（L383-391） | **无 breaking**（0.2.1-rc.5 的该路径 raw 返回 404，说明文件为新增/移动，但**不涉及本插件契约**） |

### 6.3 breaking 清单结论

**shell / sandbox / patch / 插件兼容判定四块，在 0.2.1-rc.5 → 0.2.2-rc.1 之间没有任何针对本插件的 breaking change。** 现插件的四条依赖面全部保持：

| 依赖面 | 结论 |
|---|---|
| `SandboxPwshExecutor extends PwshLocalExecutor` 且 `execute` 可 override | 保持（`pwsh-sandbox/src/index.ts:52,96`） |
| `ShellExecSpec` 10 字段且 `command` 可替换 | 保持（`shell/src/types.ts:111-137`） |
| `ctx.shell` 单实现约束 | 保持（`shell/src/index.ts:36-40`、`shell/README.md:12,38`） |
| patch 的 `id` 覆盖 + `insert` 语法 + `!!js` | 保持（`vendor/include/src/patch.ts:47-109`、`index.ts:16-25`） |
| peer 判定 `semver.satisfies(runtime, range, {includePrerelease:true})` | 保持（`plugin-compatibility.ts:51-53`） |

### 6.4 无法取证的项（如实标注）

| 项 | 原因 |
|---|---|
| 0.2.1-rc.5 → 0.2.2-rc.1 的**完整提交清单与提交信息** | 浅克隆 + `ops_bash` 不可用，无法 fetch 历史 |
| `docs/subsystems/shell.md` 是否为 0.2.2-rc.1 新增/改动 | 该文档是 `scripts/gen-doc-graphs.ts` 生成物（`docs/tool-execution-pipeline.md:1-2`），但 shell.md 无该头，无法判定其版本引入点；不过其**内容**与源码一致，可作权威引用 |
| `packages/core/tools/src/contracts.ts` 在 0.2.1-rc.5 的状态 | raw 返回 `404: Not Found`，说明当时路径不同（文件新增/迁移），与本插件无关 |

---

## ⑦ 对当前插件实现的逐条判定（给实现者的行动项）

### 7.1 判定总表

| # | 现行做法 | 位置 | 判定 | 依据 |
|---|---|---|---|---|
| 1 | `import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'` | `index.js:80`（经 `createRequire` 间接加载） | **合规，可保留** | `pwsh-sandbox/src/index.ts:200` default + `:52` 具名导出 |
| 2 | `export default class RtkPwshExecutor extends SandboxPwshExecutor` | `index.js:135` | **合规，且是文档指明路径** | `docs/subsystems/shell.md:249`；`pwsh-sandbox/src/index.ts:96` 是 `override` |
| 3 | `async execute(spec) { ... }` 覆盖 | `index.js:136` | **合规** | 同上；`pwsh-local/src/index.ts:235-238` 明确为子类预留改写点 |
| 4 | `return await super.execute({ ...spec, command: rewritten })` | `index.js:150` | **合规且字段完整**——`...spec` 展开保留全部 10 字段 | `shell/src/types.ts:111-137` 字段表（本报告 1.3） |
| 5 | 失败时 `return super.execute(spec)` 原样透传 | `index.js:155` | **合规**——失败安全语义与上游"绝不阻断"一致 | `pwsh-sandbox/README.md:94`（fail closed 只针对沙箱，不包括本插件改写） |
| 6 | `cordis.patch.yml` 先 `- id: pwsh-sandbox / disabled: true` | `cordis.patch.yml:5-6` | **合规且必须**——否则双 `ctx.shell` 抛错 | `shell/src/index.ts:36-40`、`shell/README.md:12,38` |
| 7 | 再 `- insert:` 自己的行 | `cordis.patch.yml:8-15` | **合规** | `vendor/include/src/patch.ts:79-81`（无 id 的 insert 追加到顶层） |
| 8 | insert 行 `disabled: !!js process.platform !== 'win32'` 镜像 base | `cordis.patch.yml:15` | **合规** | base 行同构 `bundle/base/cordis.patch.yml:257`；求值语义 `app-boot/src/index.ts:487-495` |
| 9 | insert 行 `name: dsh-pwsh-rtk-rewrite`（= 包名） | `cordis.patch.yml:13` | **合规**——`name` 是模块解析依据 | `patch.ts:97-100` name 匹配；`profile-plugins.ts:67,74` bundles 按包名 |
| 10 | `dsh.bundle.patch: "./cordis.patch.yml"` | `package.json:40-44` | **合规** | `profile.ts:54-71` |
| 11 | `files` 含 `cordis.patch.yml` | `package.json:9-14` | **合规且必须**（漏了会导致安装后 bundle 被 skip） | `profile.ts:101-107` |
| 12 | `peerDependencies['@deepseek-ai/dsh-pwsh-sandbox']` 范围覆盖 0.2.x | `package.json:33` | **合规，且已覆盖 0.2.2-rc.1** | `plugin-compatibility.ts:51-53,69`；本报告 5.2 表 |
| 13 | `peerDependenciesMeta.optional: true` | `package.json:35-39` | **合规**——且与代码实际加载方式（从 dsh 安装目录解析）一致 | `index.js:49-78` 解析链；`plugin-compatibility.ts:65-72` 不因 optional 跳过检查 |
| 14 | `devDependencies: { "@deepseek-ai/dsh-pwsh-sandbox": "0.2.1-rc.3" }` | `package.json:46` | **建议升级**（非阻塞） | 见 7.2 第 1 项 |
| 15 | 未声明 `engines.dsh` | `package.json:29-31`（只有 `engines.node`） | **合规，且当前是正确的选择** | 一旦声明 `engines.dsh`，peerDependencies 全部被忽略（`plugin-compatibility.ts:56-61`），会失去对 sandbox 包的约束 |

### 7.2 必须改 / 建议改（具体到行）

#### 【无必须改项】

上游契约层面**没有任何一行必须改**才能继续在 0.2.2-rc.1 上工作。现实现的四个契约面（执行器继承、spec 展开、patch 文法、peer 判定）全部成立。

#### 建议改 1：`package.json:46` devDependency 版本对齐

```
改前：  "devDependencies": { "@deepseek-ai/dsh-pwsh-sandbox": "0.2.1-rc.3" }
改后：  "devDependencies": { "@deepseek-ai/dsh-pwsh-sandbox": "0.2.2-rc.1" }
```

**理由**：devDependency 只影响本地类型/调试参照，不参与运行时（运行时从 dsh 安装目录解析，`index.js:49-78`）。对齐到上游 HEAD 可避免后续人工对读时踩到 rc.3 的旧认知。
**风险**：若 npm 上 `0.2.2-rc.1` 尚未发布，`pnpm install` 会失败。**执行前先核对 registry**；未发布则**保持现状**，此项可跳过。
**非必须，不阻塞改造。**

#### 建议改 2：`index.js:1-18` 顶部注释补一句上游契约出处

现状注释已正确描述 `sandboxPolicy` 由 `resolve()` 钉入（`index.js:7-8`）与 UTF-8 前导在 spawnSpec 层（`:12-14`）。**这两条经本报告 1.3 / 2.3 复核为真**。建议追加一行指出权威文档位置，便于后续升级时自查：

```
 * Contract sources (dsh 0.2.2-rc.1):
 *  - packages/shell/shell/src/types.ts:111-137  (ShellExecSpec 字段全集)
 *  - packages/shell/pwsh-sandbox/src/index.ts:92-140  (resolve/execute 分支)
 *  - docs/subsystems/shell.md:249  (official subclass path)
 *  - vendor/include/src/patch.ts:47-109  (id 覆盖 / insert 语义)
```

**纯注释，无行为影响。**

#### 建议改 3（可选）：把 `execute` 的 `spec` 断言收窄

`index.js:140` 现用 `spec.command.trimStart()`。上游 `command` 类型是 `string` 且必填（`shell/src/types.ts:112`），**无空值风险**，但若上游未来允许空命令，`''` 会走 `startsWith` 返回 false → 进 `rtkRewrite('')`。建议保持现状即可，**不必改**——`rtkRewrite` 拿到空串会由 rtk 返回无等价（exit 1），最终 `super.execute` 执行原命令，行为安全。

### 7.3 明确"不要做"的事（防止实现者走偏）

| 不要做 | 原因 |
|---|---|
| **不要**改成订阅 `tools/pre-execute` 来改写命令 | 契约明文排除输入改写（`core/tools/src/contracts.ts:348-356`）；`PreToolDecision` 无 replace 态（L357-361） |
| **不要**在 `tools/execute` 里改 `exec.arguments` | 「wrappers may change only `exec.signal`」（`core/tools/src/events.ts:20-28`）；且 `arguments` 是 `readonly` 且已深度冻结（`contracts.ts:184-185, 212-218`） |
| **不要**指望 hook 桥的 `updatedInput` | 显式标注「PARSED but NOT honored — input rewrite is deferred」（`hook-protocol/src/types.ts:132-136`） |
| **不要**在 `execute` 里包一层新对象返回 | `decorateResult` 依赖句柄同一性（`pwsh-sandbox/src/index.ts:144-159` 注释 + `processFacts` 以实例为 key，L113） |
| **不要**改 `spec.workdir` / `spec.sandboxPolicy` / `spec.signal` | 分别影响沙箱归属、fail-closed 归因（`isRunnerSpawnFailure(…, spec.workdir)`，`pwsh-sandbox/src/index.ts:135`）、取消归因（L134） |
| **不要**声明 `engines.dsh` | 会让 peerDependencies 全部失效（`plugin-compatibility.ts:56-61`），失去对 sandbox 包的版本约束 |
| **不要**把 insert 行的 `id` 改成 `pwsh-sandbox` | 那会命中已有行做字段覆盖而非新增，导致 `execute` 仍是原类（`patch.ts:91-105`）。现有自定义 `id: rtk-pwsh-shell` 正确 |
| **不要**去掉 `- id: pwsh-sandbox / disabled: true` 那两行 | 双 `ctx.shell` 注册直接抛错（`shell/src/index.ts:36-40`） |

### 7.4 给实现者的最短行动清单

1. 打开 `package.json:46`，核对 npm 上 `@deepseek-ai/dsh-pwsh-sandbox@0.2.2-rc.1` 是否已发布；已发布则改，未发布则保留 `0.2.1-rc.3`。
2. 可选：`index.js:1-18` 注释补契约出处（建议改 2 的文本可直接粘）。
3. **其余一律不动**——`execute` 改写逻辑、`cordis.patch.yml` 两段、`peerDependencies` 范围、`files` 白名单、`dsh.bundle.patch` 全部经本报告逐条确认合规。
4. 回归验证：`node test.js` 应仍全绿（`test.js:110-123` 的 peer 断言对本插件范围仍成立，覆盖 0.2.1-rc.5 与 0.2.2-rc.1）。

---

## 附：本报告未采纳但已排查的候选（存档备查）

| 候选 | 排查结论 | 证据 |
|---|---|---|
| `packages/shell/tool-pwsh-persistent` / `tool-bash-persistent` | 是**另一种工具实现**（持久会话），不是改写点；替换它等于换掉模型工具 | `packages/shell/README.md:34,36` |
| `ctx.sandbox.confine` 里改 argv | 能改 argv 但改不了 `command` 语义，且这层属于沙箱 provider 记账边界 | `sandbox/src/index.ts:192` |
| `packages/boot/config-editor` | 只编辑配置，不碰执行 | — |
| `packages/boot/hmr` | 热重载插件包，与命令改写无关 | — |
| `docs/module-graph.md` / `graph-atlas.md` | 生成物，不含契约语义 | — |
