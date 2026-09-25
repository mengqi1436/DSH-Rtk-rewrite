# @local/dsh-rtk-rewrite

DeepSeek Harness（DSH）原生 rtk 桥接插件：把 web profile 的 shell 执行器替换为
rtk 改写子类，**所有 pwsh shell 命令在执行前经 `rtk rewrite "<cmd>"` 透明改写**，
让 rtk 的紧凑输出格式直接为每次工具调用节省 token。

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

## 环境要求

- **DeepSeek Harness ≥ 0.1.7**（`dsh` CLI，插件机制 `dsh plugin`）
- **rtk ≥ 0.50.0** 在 PATH 上（`rtk rewrite` 子命令可用；可用 `RTK_BIN` 环境变量指定别名）
- Windows + PowerShell（插件替换的是 pwsh 执行器；bash/其他 shell 工具不受影响）

## 工作原理

DSH 的插件体系（cordis）允许一个 bundle 通过 patch 声明替换服务行。
每个 context 只允许一个 `ctx.shell` 实现，因此 patch 做两件事：

1. **禁用原执行器**：`- id: pwsh-sandbox / disabled: true`
2. **插入本插件**：`insert: - id: rtk-pwsh-shell / name: '@local/dsh-rtk-rewrite'`

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
  `@deepseek-ai/dsh-pwsh-sandbox` 版本落后于本机 dsh（registry 0.1.5-rc.3 vs
  本机 0.1.7-rc.2），故该核心包声明为 peerDependency（供市场做 host-aware
  兼容发现），运行时按顺序自动探测：`DSH_INSTALL_PACKAGE_JSON` 环境变量 →
  正常依赖链 → Windows 布局 `<node目录>/node_modules/@deepseek-ai/dsh` →
  POSIX nvm 布局 `<node目录>/../lib/node_modules/@deepseek-ai/dsh`。
- **rtk exit code 语义**（实测 rtk 0.50.0，与 `--help` 文档的 "exits 0" 不同）：
  支持的命令（含已是 rtk 形式的）exit 3 + 命令在 stdout；无等价 exit 1 无输出。
  Node v24 的 execFile 把子进程退出码放在 `err.code`（数字），spawn 失败
  （ENOENT）放字符串，所以判定统一用 `Number(err.code)`。

## 安装 / 卸载

```powershell
# 从 npm（推荐，市场同源）
dsh plugin --profile web add dsh-rtk-rewrite

# 或直接从本地源码目录（开发模式）
dsh plugin --profile web add E:\Code\dsh\Rtk

# 卸载
dsh plugin --profile web remove dsh-rtk-rewrite
```

也可以在 DSH 内置插件市场（[dshmarket](https://github.com/dsh-market/dsh-market)）中
一键安装。安装后重启 GUI / 新会话生效（替换已安装代码需重启以加载新模块代）。

若插件找不到 dsh 本体的核心包，设置环境变量 `DSH_INSTALL_PACKAGE_JSON`
指向 dsh 安装目录下的 `package.json` 即可（一般自动探测已覆盖：正常依赖链、
Windows 布局 `<node>/node_modules`、POSIX nvm 布局 `<node>/../lib/node_modules`）。

## 禁用

- **单命令**：环境变量 `RTK_DISABLED=1`（rtk 官方约定，插件同样遵守）
- **整行停用**：profile patch 中 override `rtk-pwsh-shell` 行 `disabled: true`，
  并恢复 `pwsh-sandbox` 行 `disabled: false`

## 验证

```powershell
node test.js               # rtkRewrite 判定逻辑自检 + 模块加载（全部通过 ✓）
dsh --profile web --dump-config   # 确认 pwsh-sandbox disabled、rtk-pwsh-shell 存在 ✓
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
└── README.md
```
