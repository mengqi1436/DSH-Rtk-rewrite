# dsh-pwsh-rtk-rewrite

[English](./README.md) | **中文**

DeepSeek Harness（DSH）原生 [rtk](https://github.com/rtk-ai/rtk) 桥接插件：把桌面端
profile 的 shell 执行器替换为 rtk 改写子类，**所有 pwsh shell 命令在执行前经
`rtk rewrite "<cmd>"` 透明改写**，让 rtk 的紧凑输出格式直接为每次工具调用节省 token。
当 rtk 明确 deny 某条命令时，该命令被阻止而非执行；其余情况（rtk 缺失、无等价、
超时）一律原样执行。

已在本机实测验证（2026-09-25，dsh 0.1.7-rc.2 + rtk 0.50.0 + Node v24.19.0）：

```
[rtk-rewrite] "git status" -> "rtk git status"
[rtk-rewrite] "cat E:\\CLI\\dsh-web.log" -> "rtk read E:\\CLI\\dsh-web.log"
# 连复合命令也能逐段改写：
"cat a.log; git status; grep -c x b.log"
  -> "rtk read a.log; rtk git status; rtk grep -c x b.log"
```

`rtk gain` 统计随命令执行实时上升（实验：Total commands 10274 → 10277，
与 dsh-web.log 的 3 条改写日志一一对应）。

> 该次实测早于 rtk 1.0 的四档契约，保留为 rtk 0.50.0 时期的历史记录。
> 下文描述的退出码语义，以 **2026-10-20 对照 rtk 1.0.1 的复核**为准。

## 兼容性验证

**0.2.0 兼容性**（2026-09-29 验证）：`@deepseek-ai/dsh-pwsh-sandbox@0.2.0-rc.1`
与 `0.1.7-rc.2` 的 `lib/index.js` **逐字节相同**（252 行 0 差异），`SandboxPwshExecutor`
具名导出、`execute(spec)` 签名与 resolve() 策略印章层全部不变——本插件**无需代码改动**，
peerDependencies 已扩展为 `>=0.2.0-rc.1 <0.3.0-0`（v1.1.0 起）。

**0.2.0-rc.2 兼容性**（2026-09-30 验证）：`@deepseek-ai/dsh-pwsh-sandbox@0.2.0-rc.2`
与 `0.2.0-rc.1` 的 `lib/index.js` **逐字节相同**（SHA256 一致 `BED19D2C…`，252 行 0 差异），
包内差异仅 `package.json` 的版本号与依赖版本号（rc.1 → rc.2）——rc.2 修复的「持久
PowerShell 在完成状态后带有空格时无法正确识别命令结束、丢失退出码或泄露内部标记」
问题位于 dsh 内核侧而非本 sandbox 包。另将桌面端 0.2.0-rc.2 `app.asar` 内置的
`dsh-pwsh-sandbox` 提取比对，与 npm rc.2 亦**逐字节一致**（同一 SHA256）。

**0.2.1 兼容性**（2026-10-17 验证）：`@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.2`
与 `0.2.0-rc.2` 的 `lib/index.js` **逐字节相同**（SHA256 一致 `BED19D2C…`，0 差异）
——0.2.1 系列至今仅动 README/locale/package.json 元数据。桌面端 0.2.1-rc.1
`app.asar` 内置副本提取比对亦为同一 SHA256；内核中 `pwsh-sandbox` cordis 行仍在，
上游 changelog（v0.2.1-rc.1/rc.2）无 shell 执行器或 patch 机制相关破坏性变更。
本插件**无需代码改动**，既有 peer 范围 `>=0.2.0-rc.1 <0.3.0-0` 已覆盖
0.2.1-rc.1/rc.2；`test.js` 现以 devDependency 方式加载 `0.2.1-rc.2` 副本，
在裸 node 下持续验证子类化契约。

**桌面端 0.2.1-rc.2 兼容性**（2026-10-20 验证，v1.2.0）：
`@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.2` 的 `lib/index.js` 仍与 `0.2.0-rc.2`
**逐字节相同**（同一 SHA256 `BED19D2C…`，252 行 0 差异，本次从 devDependency 副本
重新计算）。本机桌面端跑的就是这个版本：npm 上 `@deepseek-ai/dsh` 的 `latest` 与
`next` 同为 0.2.1-rc.2，上游最新 tag 为 `dsh-v0.2.1-rc.2`，rc.2 之后 master 上的
提交只动 web/llm，未触及 shell、sandbox、patch 或 executor。**内核无需升级，插件
也无需为此改代码**：v1.2.0 的四档契约完全实现在本插件的 `execute()` 里，底座仍是
未变的 `SandboxPwshExecutor`。

**桌面端适配**（2026-09-30 实机验证并修复，v1.1.3）：桌面端 0.2.0-rc.2 的 dsh 内核
打包在 `resources\app.asar` 内，桌面 profile 依赖链与 node 目录布局均解析不到内核包，
插件原四条探测链全部落空 → `rtk-pwsh-shell` 服务加载失败、patch 静默回退原生 shell
（装配层 patch 声明正确，`loadProfileDirectory` 实探确认）。v1.1.3 新增第五条
**Electron 桌面布局探测链** `<exe 目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`，
在桌面端主进程形态下实测命中（Electron 的 asar fs 支持），`node test.js` 同形态
6 项全过。装 v1.1.3 后**重启桌面端**即生效，无需设置 `DSH_INSTALL_PACKAGE_JSON`。

## 环境要求

- **DeepSeek Harness ≥ 0.1.7（含 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.1 /
  0.2.1-rc.2）桌面端**
  （`dsh` CLI，插件机制 `dsh plugin`）
- **rtk ≥ 1.0.0** 在 PATH 上——四档 `rtk rewrite` 退出码契约自 1.0 起才有
  （已对照 **rtk 1.0.1 于 2026-10-20 复核**；可用 `RTK_BIN` 指定别名）。旧版 rtk，
  或 `RTK_BIN` 指向了别的 CLI，会被**探测到并降级为 pass-through**：命令原样执行、
  绝不阻塞，只打一次警告。
- Windows + PowerShell（插件替换的是 pwsh 执行器；bash/其他 shell 工具不受影响）

## 工作原理

DSH 的插件体系（cordis）允许一个 bundle 通过 patch 声明替换服务行。
每个 context 只允许一个 `ctx.shell` 实现，因此 patch 做两件事：

1. **禁用原执行器**：`- id: pwsh-sandbox / disabled: true`
2. **插入本插件**：`insert: - id: rtk-pwsh-shell / name: 'dsh-pwsh-rtk-rewrite'`

加载后 shell 能力由 `RtkPwshExecutor` 提供，执行流程：

```
execute(spec)
  ├─ RTK_DISABLED=1 ? ──────────────────────────► 原样执行（rtk 官方开关，deny 也一并旁路）
  ├─ 命令以 "rtk "/"rtk.exe " 开头 ? ───────────► 原样执行（递归守卫）
  ├─ rtk 支持 "rewrite" ? ── 否 ────────────────► 原样执行（pass-through，绝不判 deny）
  ├─ rtk rewrite "<cmd>"（5s 超时）
  │    ├─ exit 0 / exit 3   ──► super.execute({...spec, command: 改写结果})
  │    ├─ exit 1            ──► rtk 无等价（pwsh cmdlet 等），静默原样执行
  │    ├─ exit 2            ──► DENY：命令绝不执行，返回合成失败 handle
  │    │                        （exitCode 2，stderr 写插件自己的说明；RTK_DISABLED=1 可旁路）
  │    ├─ ENOENT            ──► rtk 不在 PATH，警告一次后原样执行
  │    └─ 超时 / 其它异常    ──► 原样执行
  └─ super.execute(spec)   （SandboxPwshExecutor：沙箱 confine 包住实际执行的命令）
```

### 关键设计决策

- **默认全放行，只有一条 fail-closed 分支**：任何改写失败（rtk 缺失、无等价、
  超时、异常、rtk 不支持 `rewrite`）都跑原命令；只有一种情况会阻止执行——rtk
  明确 deny（`exit 2`，且能力探测已确认该 rtk 确有 `rewrite` 子命令）。被 deny
  的命令绝不会被 spawn。
- **用能力探测代替「读 stderr 猜」**：clap 对未知子命令和用法错误同样返回 2，
  只看退出码分不清「deny」和「这个 rtk 太老」。所以插件在首次改写前先跑一次
  `<rtk> rewrite --help`，退出 0 即视为支持 `rewrite`。不支持该子命令的 rtk
  （rtk < 1.0，或 `RTK_BIN` 指到了别的 CLI）根本进不到四档判定，因此不可能被
  误判成 deny，shell 照常以不改写方式工作。探测结果缓存：支持则永久缓存（后续
  每条命令零开销），不支持则在 60 秒后重探（用户就地升级 rtk 后可自行恢复），
  警告只打一次。这一点正是为了防止「外部二进制版本不符」把整个 shell 变成
  拒绝器。
- **deny 返回合成失败 handle**：没有真实进程，而 DSH 的结果类型里没有「命令未
  执行」专用字段，所以插件自行拼出 `ShellExecution` 形状——`status: 'completed'`、
  `exitCode: 2`、把拒绝说明写进 `stderr`（也可经 `readOutput()` 与
  `observed.stderr` 读到）、`kill()` 空操作、`done` 已了结。rtk 1.0.1 从不提供
  拒绝理由（exit 2 不打印任何内容），所以说明文案是插件自己的：
  `rtk denied this command; it was not executed.` 消息只从 stdout 取，并丢掉以
  `[rtk] ` 开头的行，因此 hook 噪声永远不会被当成拒绝理由。调用方拿到的是带原因
  的失败，而不是空白成功。
- **`sandbox.denied` 保留沙箱自己的语义**：该字段表示沙箱是否拒绝了文件操作。
  rtk deny 时它仍为 `false`，拒绝改用非零 `exitCode` + `stderr` 表达。
- **stderr 上的 `[rtk] No hook installed` 提示无害，且插件不去管它**：四档每次
  调用 rtk 都会打印这条 79 字节提示，没有节流，也没有 `--quiet` 选项（只能靠
  `RTK_SUPPRESS_HOOK_WARNING=1|on` 或 rtk 自身配置里的
  `suppress_hook_warning = true` 抑制）。插件只读 stdout，噪声不影响任何判定；
  插件也刻意不去设那个变量——那会改动用户的 rtk 全局环境，收益为零。
- **沙箱语义完整保留**：只覆写 `execute(spec)`，`resolve()`（沙箱 policy stamp）
  不动；用展开 `{ ...spec, command: rewritten }` 传递，workdir/timeoutMs/signal/
  stdin/env 与沙箱字段全部原样。沙箱 confine 包裹的是**改写后**的命令。
- **spec.command 是原始命令**：UTF-8 preamble 在 `PwshLocalExecutor` 的 spawnSpec
  层才拼接，`execute()` 看到的命令文本可安全直接喂给 `rtk rewrite`。
- **内置包从 dsh 本体安装路径解析**：npm 上的
  `@deepseek-ai/dsh-pwsh-sandbox` 版本常落后或超前于本机 dsh 运行时
  （registry 曾长期停在 0.1.5-rc.3，0.2.0 起恢复发布但与桌面版装配仍可能错位），
  故该核心包声明为 peerDependency（供市场做 host-aware
  兼容发现），运行时按顺序自动探测：`DSH_INSTALL_PACKAGE_JSON` 环境变量 →
  正常依赖链 → Windows 布局 `<node目录>/node_modules/@deepseek-ai/dsh` →
  POSIX nvm 布局 `<node目录>/../lib/node_modules/@deepseek-ai/dsh` →
  Electron 桌面布局 `<exe目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`
  （v1.1.3 起，桌面端主进程内 fs 对 asar 透明，实测命中）。
- **rtk 退出码语义**（四档，逐条对应 rtk 1.0.1 的 `rtk rewrite --help`，并对照
  1.0.1 源码于 2026-10-20 复核）：`0`——已打印改写、allow 规则覆盖每条命令 →
  用改写结果；`1`——无输出、无改写（无 RTK 等价、配置中排除了该命令、rtk 不改写
  的语法结构如 `$(...)` 或文件重定向、shell 包装脚本内部命中了 deny 规则）→
  静默原样执行；`2`——deny 命中、最先判定 → 阻止执行。**`rtk rewrite` 在 exit 2
  时不打印任何内容**：`src/hooks/rewrite_cmd.rs` 从 `Deny` 分支直接退出，上游
  契约表里 exit 2 那一行写的就是 `(none)`；`--help` 里「有消息打印 = rtk pipeline
  规则拒绝或路由了该命令」指的是进程内 `rtk hook <agent>` 的 JSON 协议路径
  （那条路径退出码恒 0），不是本子命令。`3`——已打印改写，命中的是 ask 规则或
  allow 规则未全覆盖 → 采用改写并把审批交给宿主（本插件没有审批通道，故直接按
  改写执行）。
- **exit 0 与 exit 3 的 stdout 完全相同**——都是同一份 `rtk <cmd>` 文本——所以
  退出码是区分「allow 已覆盖」与「宿主需要审批」的唯一依据。四档必须读退出码，
  不能靠「stdout 是否为空」判断，这条不要被「简化」掉。
- **规则来源是 Claude Code 的 settings，不是 rtk 自己的配置**：`0`/`2` 由
  `.claude/settings*.json`（cwd 及其祖先目录）决定，`%APPDATA%\rtk\` 下的 rtk
  配置只影响 `[hooks] exclude_commands` 之类。本工作区的祖先链上没有任何
  `.claude` 目录，所以本机实际只会遇到 1 和 3 两档；0 与 2 需写入
  `permissions.allow` / `permissions.deny` 才能触发。
- **上游 1.0.2 不改契约**：develop 上的 `src/hooks/rewrite_cmd.rs` 与 v1.0.1
  **字节相同**（12,290 B）；那里的 `decision.rs` 改动只涉及 agent 路径。
- **Node v24 的退出码管道**：`execFile` 把子进程退出码放在 `err.code`（数字），
  spawn 失败（ENOENT）放字符串，所以判定统一走 `Number(err.code)`。
- **`RTK_DISABLED=1` 仅在插件 JS 层生效**（改写前自查，同时旁路 deny）。
  `rtk rewrite` 子命令本身不认该变量（rtk 1.0.1 复核）：设了 `RTK_DISABLED=1`
  再手动跑 `rtk rewrite` 仍然会改写。

## 安装 / 卸载

**前置**：DSH 桌面端 **0.2.0-rc.2+** 已捆绑 `dsh` 命令——在桌面端菜单栏点击
**"Manage dsh command"（管理 dsh 命令）** 完成安装即可，无需另装 Node/pnpm。

**安装**（必须钉精确版本：`@latest` 会被 release-age 校验回落到旧版）：

```powershell
dsh plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.2.0 --registry=https://registry.npmjs.org/
```

**卸载**：

```powershell
dsh plugin --profile desktop remove dsh-pwsh-rtk-rewrite
```

也可以在 DSH 内置插件市场（[dshmarket](https://github.com/dsh-market/dsh-market)）中
一键安装。安装后重启桌面端 / 新会话生效（替换已安装代码需重启以加载新模块）。

**内核包解析说明**：桌面端 dsh 内核打包在安装目录的 `app.asar` 内（Windows 下
如 `E:\Tool\DSH\resources\app.asar\dsh\`），桌面 profile 的依赖链与 node 目录布局
均探测不到内核包。**v1.1.3 起插件新增 Electron 桌面布局探测链，在桌面端进程内
自动命中 `app.asar` 内核包，无需任何配置**。旧版本（≤ 1.1.1）在桌面端会因解析
失败而静默回退原生 shell（表现为装了插件但 rtk 不生效），手动兜底方式是在
**桌面端进程环境**里设 `DSH_INSTALL_PACKAGE_JSON` 指向
`<桌面端安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json`；
升级到 v1.1.3 即无需此变量。

**验证**：重启桌面端后跑一条 rtk 必认识的命令（如 `git status`），对比
`rtk gain` 的 Total commands 计数上升即生效；或在工具输出中看到 rtk 紧凑格式。

**生效**：桌面端同样是 Windows + pwsh 环境，插件照常生效；安装完成后**重启桌面端**
生效。

## 禁用

- **单命令**：环境变量 `RTK_DISABLED=1`（rtk 官方约定，插件在 JS 层遵守，
  且连带旁路 rtk 的 deny）
- **整行停用**：profile patch 中 override `rtk-pwsh-shell` 行 `disabled: true`，
  并恢复 `pwsh-sandbox` 行 `disabled: false`

## 验证

```powershell
node test.js               # 40 项断言 + 1 项预期 skip
```

`test.js` 覆盖了什么——既有 PATH 上真实的 `rtk 1.0.1`，也有一个以真实子进程运行、
返回真实退出码的假 rtk 桩（stub）：

- **四档契约**：exit 0 → 改写、exit 3 → 改写、exit 1 → 不改写、exit 2 → deny 结果。
  真实 rtk 1.0.1 的 exit 2 不打印任何内容，故拒绝说明是插件自己的文案；桩另外覆盖
  了「stdout 带消息的 exit 2」与「stderr 只有噪声的 exit 2」两种形态，后者要求
  `[rtk] ` 行被丢弃——hook 噪声绝不能变成拒绝理由
- **deny 是 fail-closed 的**：`super.execute()` 从未被调用；合成 handle 以
  `exitCode: 2` 了结，stderr 明确写出命令被拒绝且未执行，`sandbox.denied` 保持
  `false`，`kill()` 为空操作，`readOutput()` 读完即空
- **改写路径**：改写后的命令连同 spec 其余字段（workdir、timeoutMs）一起交给
  `super.execute()`；`RTK_DISABLED=1` 与递归守卫都会跳过改写——前者连 deny 一并
  旁路
- **能力探测降级**：rewrite 属未知子命令的旧版 rtk（clap 退出 2）、以及 `RTK_BIN`
  指向无关真实二进制的场景，都降级为 pass-through 而绝不判 deny；探测结果被缓存
  （多次执行只探测一次，不是每条命令探一次），且递归守卫在探测之前就旁路

裸 node 下真实桌面端的 asar 命中检查会打印 `skip:`——asar 只有在 Electron 主进程
内才可读，所以这项 skip 属预期。测试加载 devDependency 里的 sandbox 包副本，
因此始终以 `0.2.1-rc.2` 验证子类化契约。

运行时验证（三重证据互相印证）：

1. **harness 日志**：shell 命令执行时出现 `[rtk-rewrite] "orig" -> "rewritten"`
   （web 模式下落在启动重定向的日志文件，如 `dsh-web.log`）
2. **rtk history.db**（`C:\Users\<user>\AppData\Local\rtk\history.db`）：每次成功
   改写入库一条 `original_cmd → rtk_cmd` 记录
3. **`rtk gain`**：Total commands 计数随命令执行上升

> 注意：探针要选 rtk **必定认识**的命令（`git status`、`cat` 等）。
> pwsh 特有命令（`Write-Output`、裸 `Get-ChildItem` 等）rtk 报 exit 1 无等价，
> 静默且不入库——**无记录 ≠ 插件未工作**，这是排查时最容易踩的坑。

## 文件结构

```
├── index.js          # RtkPwshExecutor（唯一源码：rtkRewrite + execute 拦截）
├── cordis.patch.yml  # bundle patch：禁用 pwsh-sandbox + 插入 rtk-pwsh-shell
├── package.json      # dsh.bundle.patch 指向 patch 文件；无运行时 npm 依赖
├── test.js           # 自检：四档契约 + 假 rtk 桩 + 能力探测降级（40 项断言）
├── README.md         # English
└── README_zh.md      # 中文（本文件）
```

## License

[MIT](LICENSE) © 2026 mengqi1436
