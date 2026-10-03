# dsh-pwsh-rtk-rewrite

[English](./README.md) | **中文**

DeepSeek Harness（DSH）原生 [rtk](https://github.com/rtk-ai/rtk) 桥接插件：把桌面端
profile 的 shell 执行器替换为 rtk 改写子类，**所有 pwsh shell 命令在执行前经
`rtk rewrite "<cmd>"` 透明改写**，让 rtk 的紧凑输出格式直接为每次工具调用节省 token。

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

**桌面端适配**（2026-09-30 实机验证并修复，v1.1.3）：桌面端 0.2.0-rc.2 的 dsh 内核
打包在 `resources\app.asar` 内，桌面 profile 依赖链与 node 目录布局均解析不到内核包，
插件原四条探测链全部落空 → `rtk-pwsh-shell` 服务加载失败、patch 静默回退原生 shell
（装配层 patch 声明正确，`loadProfileDirectory` 实探确认）。v1.1.3 新增第五条
**Electron 桌面布局探测链** `<exe 目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`，
在桌面端主进程形态下实测命中（Electron 的 asar fs 支持），`node test.js` 同形态
6 项全过。装 v1.1.3 后**重启桌面端**即生效，无需设置 `DSH_INSTALL_PACKAGE_JSON`。

## 环境要求

- **DeepSeek Harness ≥ 0.1.7（含 0.2.0-rc.1 / 0.2.0-rc.2）桌面端**
  （`dsh` CLI，插件机制 `dsh plugin`）
- **rtk ≥ 0.50.0** 在 PATH 上（`rtk rewrite` 子命令可用；可用 `RTK_BIN` 环境变量
  指定别名）。契约已于 2026-10-03 对照 rtk 0.51.0 复核：退出码语义不变。
- Windows + PowerShell（插件替换的是 pwsh 执行器；bash/其他 shell 工具不受影响）

## 工作原理

DSH 的插件体系（cordis）允许一个 bundle 通过 patch 声明替换服务行。
每个 context 只允许一个 `ctx.shell` 实现，因此 patch 做两件事：

1. **禁用原执行器**：`- id: pwsh-sandbox / disabled: true`
2. **插入本插件**：`insert: - id: rtk-pwsh-shell / name: 'dsh-pwsh-rtk-rewrite'`

加载后 shell 能力由 `RtkPwshExecutor` 提供，执行流程：

```
execute(spec)
  ├─ RTK_DISABLED=1 ? ────────────────► 原样执行
  ├─ 命令以 "rtk "/"rtk.exe " 开头 ? ──► 原样执行（递归守卫）
  ├─ rtk rewrite "<cmd>"（5s 超时）
  │    ├─ exit 3 + stdout ──► 用改写后命令 super.execute({...spec, command})
  │    ├─ exit 1            ──► rtk 无等价（pwsh cmdlet 等），静默原样执行
  │    ├─ ENOENT            ──► rtk 不在 PATH，警告一次后原样执行
  │    └─ 超时/其他失败      ──► 原样执行
  └─ super.execute(spec)   （SandboxPwshExecutor：沙箱 confine 包住改写后命令）
```

### 关键设计决策

- **失败安全**：任何改写失败（rtk 缺失、无等价、超时、异常）都跑原命令，
  绝不阻塞或拒绝执行。插件只做「锦上添花」，永远不影响可用性。
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
- **rtk exit code 语义**（实测 rtk 0.50.0，2026-10-03 对照 0.51.0 复核；
  与 `--help` 文档的 "exits 0" 不同）：支持的命令（含已是 rtk 形式的）exit 3 +
  命令在 stdout；无等价 exit 1 无输出。Node v24 的 execFile 把子进程退出码放在
  `err.code`（数字），spawn 失败（ENOENT）放字符串，所以判定统一用
  `Number(err.code)`。
- **`RTK_DISABLED=1` 仅在插件 JS 层生效**（index.js 改写前自查）。`rtk rewrite`
  子命令本身不认该变量（rtk 0.51.0 实测）：设了 `RTK_DISABLED=1` 后手动跑
  `rtk rewrite` 仍会改写。

## 安装 / 卸载

**前置**：DSH 桌面端 **0.2.0-rc.2+** 已捆绑 `dsh` 命令——在桌面端菜单栏点击
**"Manage dsh command"（管理 dsh 命令）** 完成安装即可，无需另装 Node/pnpm。

**安装**（必须钉精确版本：`@latest` 会被 release-age 校验回落到旧版）：

```powershell
dsh plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.1.3 --registry=https://registry.npmjs.org/
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

- **单命令**：环境变量 `RTK_DISABLED=1`（rtk 官方约定，插件在 JS 层遵守）
- **整行停用**：profile patch 中 override `rtk-pwsh-shell` 行 `disabled: true`，
  并恢复 `pwsh-sandbox` 行 `disabled: false`

## 验证

```powershell
node test.js               # rtkRewrite 判定逻辑自检 + 模块加载
                           #（模块加载断言仅在 Electron 桌面端主进程内可过；
                           #  裸 node 读不到 asar 内核包，该项会报失败，属预期）
```

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
├── package.json      # dsh.bundle.patch 指向 patch 文件；无 npm 依赖
├── test.js           # 最小自检：改写判定规则行为验证 + 模块加载
├── README.md         # English
└── README_zh.md      # 中文（本文件）
```

## License

[MIT](LICENSE) © 2026 mengqi1436
