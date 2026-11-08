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

2026-11-08 在本机重新确认（Windows 11 10.0.26300 + rtk 1.1.0 + Node v26.13.0 +
DSH 桌面端 0.2.2-rc.1）：退出码契约未变，下文命令族表的全部条目即当日用
`rtk rewrite` 实测得出。

**不用白名单、不用逐命令配置、不用注册任何东西。** 插件把整条命令字符串交给
`rtk rewrite`，rtk 返回什么就用什么，所以覆盖范围**等于你装的 rtk 认识的范围**——
全部 12 个命令族（见[支持的命令族](#支持的命令族)）装好插件当天即可用，rtk 以后新增的
命令族也无需升级插件。

## 支持的命令族

rtk 按生态把过滤器放在 `src/cmds/` 下
（[上游目录结构](https://github.com/rtk-ai/rtk/tree/develop/src/cmds)）：11 个生态目录
加上与语言无关的 `system`，共 12 个族（目录列表与 `src/cmds/mod.rs` 一致：
`cloud dotnet git go js jvm php python ruby rust scala system`）。下表列出各族会被改写的
命令；每条都在本机跑过 `rtk rewrite` 并确认返回了非空改写结果。

| 族 | 会被改写的代表性命令 |
|----|----------------------|
| **cloud** | `aws …`、`docker ps`、`kubectl get`、`oc get`、`curl`、`wget`、`psql`、`gcloud`、`helm`、`terraform plan`、`tofu plan`、`pulumi preview`、`ansible-playbook`、`rsync`、`sops`、`iptables`、`systemctl status`、`ping`、`skopeo`、`ssh`、`brew install`、`composer install`、`liquibase` |
| **dotnet** | `dotnet build`、`dotnet restore` |
| **git** | `git status/log/diff/show/add/commit/checkout/push/pull/branch/fetch/stash/worktree/ls-tree`、`gh pr/issue/run/repo/api/release`、`glab mr/issue/ci/pipeline/api/release`、`gt …`、`jj …`、独立 `diff` |
| **go** | `go test/build/vet`、`golangci-lint run` |
| **js** | `npm`/`pnpm`/`npx`/`bun`/`bunx`/`deno` 各类调用、`tsc`、`eslint`/`biome`/`lint`、`prettier`、`next build`、`ng build`、`jest`、`vitest`、`playwright`、`prisma` |
| **jvm** | `mvn`/`./mvnw`/`mvnd`、`./gradlew`/`gradle` |
| **php** | `php artisan …`、`php -l`、`phpunit`、`phpstan analyse`、`pest`、`paratest`、`ecs`、`pint`、`phpt` |
| **python** | `pytest`、`python -m pytest`、`ruff check/format`、`mypy`、`python -m mypy`、`pip list/outdated/install/show`、`uv run/sync/pip install`、`sqlfluff lint`、`poetry install/lock/update`、`basedpyright` |
| **ruby** | `bundle install/update`、`rake test`、`rails test`、`rspec`、`rubocop` |
| **rust** | `cargo build/test/clippy/check/fmt/install` |
| **scala** | `sbt test/testOnly/testQuick/compile/run/clean/assembly/package` |
| **system** | `cat`/`head`/`tail`（→ `rtk read`）、`grep`、`rg`、`ast-grep`、`ls`、`find`、`tree`、`wc`、`diff`、`ctest`、`du`、`df`、`ps`、`stat`、`jq`、`just`、`make`、`mix`、`pio run`、`quarto render`、`task`、`turbo`、`trunk build`、`nx`、`yamllint`、`shellcheck`、`markdownlint`、`hadolint`、`gcc`、`ty` |

除 12 个源码族之外，rtk 还有 TOML 声明的过滤器（`src/filters/*.toml`，上游 62 个）。
它们走同一个 `rtk rewrite` 入口，同样不需要插件做任何改动。

没有 rtk 等价的命令返回 exit 1，原样执行。实际就是**pwsh cmdlet 与 shell 内建**：
`Get-ChildItem`、`Get-Process`、`Write-Output`、`echo`、`env`，以及 rtk 刻意不动的情形
（`sudo …`、带写重定向的 `git status > out.txt`、带 `--json` 的 `gh`、带 `-n` 以外旗标的
`cat`）。这是预期行为：没有等价意味着没有收益，不是出错。

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
0.2.1-rc.1/rc.2；当时 `test.js` 以 devDependency 方式加载 `0.2.1-rc.2` 副本，
在裸 node 下持续验证子类化契约（该 pin 后续已随 0.2.1-rc.3 更新，见下条）。

**0.2.1-rc.3 兼容性**（2026-10-24 验证）：`@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.3`
与 `0.2.1-rc.2` 的 `lib/index.js` **逐字节相同**（SHA256 一致 `BED19D2C…`，252 行
0 差异），包内差异仅 `package.json`——版本号及其内部依赖版本号（rc.2 → rc.3）。
上游 [dsh-v0.2.1-rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)
changelog 无 shell 执行器或 patch 机制相关破坏性变更：对 `dsh-v0.2.1-rc.2` 做全量
tree 比对，`packages/shell/**`、`packages/sandbox/**`、`packages/subprocess/**` 仅各自
`package.json` 的版本号变化（无源码文件变更），patch 文法文件
`packages/bundle/base/cordis.patch.yml` 两 tag 完全一致（唯一变动的
`cordis.patch.yml` 是 web bundle 新增一条 UI 入口定制插件行）。本插件**无需代码改动**，
既有 peer 范围 `>=0.2.0-rc.1 <0.3.0-0` 在 DSH 的
`semver.satisfies(..., { includePrerelease: true })` 判定下已覆盖 0.2.1-rc.3。本条核查
当时 `test.js` 仍以 devDependency 方式加载 `0.2.1-rc.3` 副本；该套件此后改为通过
`DSH_INSTALL_PACKAGE_JSON` 注入假宿主包，不再依赖这个 pin 被安装。本条通过比对 npm 包与
上游仓库 tree 得出，未对桌面端做重新安装复验。

**0.2.2-rc.1 兼容性**（2026-11-08 验证，对照上游 `master` HEAD `fcc0ad4`）：本插件依赖的
四个契约面**均无破坏性变更**。`packages/shell/shell/src/types.ts` 里 `ShellExecRequest`、
`ShellExecSpec`（同样 10 个字段、同样可空性）、`ShellRunResult`、`ShellProcess`、
`ShellExecution`、`ShellSandboxInfo`、`ShellExpiryPolicy` 与 0.2.1-rc.5 逐字段一致；
`SandboxPwshExecutor` 仍继承 `PwshLocalExecutor`，`execute(spec)` 仍是可覆盖的
`override`（非 final），三分支（`danger-full-access` / confined / `confined === undefined`）
与结果句柄的原地 memoize 均保留；`packages/shell/pwsh-sandbox` 与
`packages/shell/pwsh-local` 的 `Config` 字段、`resolve` 逻辑、`argv()`（含编码 preamble）
与 `onProcessDone` 签名均未变。patch 文法未变——base bundle 里的 `- id: pwsh-sandbox` 行
仍在，id-target 照旧命中。插件**无需代码改动**；peer 范围 `>=0.2.0-rc.1 <0.3.0-0`
在 DSH 使用的 `satisfies(..., { includePrerelease: true })` 语义下同样覆盖 0.2.2-rc.1。
两点如实说明：本地上游仓库是 `--depth 1` 浅克隆且没有 per-package CHANGELOG，因此本条是
按 `master` 的源文件逐个比对，而非按 commit 区间比对；`devDependencies` 仍钉 `0.2.1-rc.3`，
该项只影响本地类型/调试参照，不参与运行时解析。

**桌面端适配**（2026-09-30 实机验证并修复，v1.1.3）：桌面端 0.2.0-rc.2 的 dsh 内核
打包在 `resources\app.asar` 内，桌面 profile 依赖链与 node 目录布局均解析不到内核包，
插件原四条探测链全部落空 → `rtk-pwsh-shell` 服务加载失败、patch 静默回退原生 shell
（装配层 patch 声明正确，`loadProfileDirectory` 实探确认）。v1.1.3 新增第五条
**Electron 桌面布局探测链** `<exe 目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`，
在桌面端主进程形态下实测命中（Electron 的 asar fs 支持）；当时 `node test.js` 在该形态下
6 项全过（该套件此后重建为[验证](#验证)一节所列的 8 组，桌面端 asar 候选路径现由 H 组做
结构断言）。装 v1.1.3 后**重启桌面端**即生效，无需设置 `DSH_INSTALL_PACKAGE_JSON`。

## 环境要求

- **DeepSeek Harness ≥ 0.1.7（含 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.1 /
  0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.2-rc.1）桌面端**
  （`dsh` CLI，插件机制 `dsh plugin`）
- **`rtk rewrite` 子命令可用**且在 PATH 上（上游参考 hook 标注 `Requires: rtk >= 0.23.0`；
  可用 `RTK_BIN` 环境变量指定别名或非 PATH 安装）。契约已对照 rtk 0.50.0 实测、
  2026-10-03 对照 0.51.0 复核、2026-11-08 再对照 1.1.0 复核：退出码语义全程未变。
- Windows + PowerShell（插件替换的是 pwsh 执行器；bash/其他 shell 工具不受影响）

## rtk 版本兼容性

插件不钉一个很窄的 rtk 版本区间，因为它只消费 `rtk rewrite` 的**进程契约**
（退出码 + stdout），从不链接 rtk 内部。该契约在已探测的每个版本上都稳定：

| rtk 版本 | 探测时间 | 结果 |
|----------|----------|------|
| 0.50.0 | 2026-09-25 | 支持的命令 exit 3 + stdout，其余 exit 1 无输出 |
| 0.51.0 | 2026-10-03 | 不变 |
| 1.1.0（本机） | 2026-11-08 | 不变；上文命令族表的全部实测即基于此版本 |

**上游 `develop` 跑到发布线前面，这不构成兼容性问题。** 当前上游 `develop` 停在 tag
`dev-1.2.0-rc.620`，而它自己的 `Cargo.toml` 仍写 `0.49.0`、`CHANGELOG.md` 也止于
`0.49.0`——这是三套不同的编号轨（`dev-*` 构建 tag、release-please 发布版本、以及本机
`1.1.0` 这类安装包版本）。它们**不是可比的 semver**，所以「本机 1.1.0 落后于 1.2.0-rc」
是错误读法。真正要看的是逐命令实测的能力：本机 1.1.0 已实现完整契约（exit 3 语义、
恒等透传、复合/管道改写、`RTK_DISABLED=` 前缀处理）。

**命令覆盖随 rtk 增长，不随本插件增长。** 所有改写规则都在 rtk 二进制里（原生规则在
`src/discover/rules.rs`，另有 `src/filters/` 下 62 个 TOML 过滤器）。因此升级 rtk 就会
**自动扩大覆盖范围，无需升级插件**：插件只转发 rtk 的返回值，自己不含任何规则表。
反过来说，单独升级插件不会扩大覆盖范围。

## 工作原理

DSH 的插件体系（cordis）允许一个 bundle 通过 patch 声明替换服务行。
每个 context 只允许一个 `ctx.shell` 实现，因此 patch 做两件事：

1. **禁用原执行器**：`- id: pwsh-sandbox / disabled: true`
2. **插入本插件**：`insert: - id: rtk-pwsh-shell / name: 'dsh-pwsh-rtk-rewrite'`

加载后 shell 能力由 `RtkPwshExecutor` 提供，执行流程：

```
execute(spec)
  ├─ RTK_DISABLED=1 ? ────────────────► 原样执行
  ├─ 命令已是 rtk 调用形态 ? ──────────► 原样执行（递归守卫）
  ├─ rtk rewrite "<cmd>"（5s 超时）
  │    ├─ exit 0 + stdout ──► 用改写后命令 super.execute({...spec, command})
  │    ├─ exit 3 + stdout ──► 用改写后命令 super.execute({...spec, command})
  │    ├─ exit 1            ──► rtk 无等价（pwsh cmdlet 等），静默原样执行
  │    ├─ exit 2            ──► rtk deny 规则命中，原样执行
  │    ├─ ENOENT            ──► rtk 不在 PATH，警告一次后原样执行
  │    └─ 超时/其他失败      ──► 原样执行
  └─ super.execute(spec)   （SandboxPwshExecutor：沙箱 confine 包住改写后命令）
```

### 失败安全语义

除「rtk 给出一条改写后的命令」以外的所有情形，最终都执行原命令。插件绝不阻断、
绝不拒绝、绝不降级沙箱：

| 情形 | 插件行为 |
|------|----------|
| rtk 未安装 / 不在 PATH（ENOENT） | 每个进程**只警告一次**，随后执行原命令 |
| rtk 无等价（exit 1） | 静默透传——这是 pwsh cmdlet（`Get-ChildItem`、`Write-Output`、`echo`、`env`）的常态 |
| rtk deny 规则命中（exit 2） | 透传；权限决策属于宿主，不属于本插件 |
| rtk 超过 5s 预算 | 警告、杀掉子进程、执行原命令 |
| rtk 出现上游未定义的退出码或崩溃 | 丢弃 stdout，执行原命令——无法识别的码一律不当成改写 |
| 改写结果与输入逐字节相同 | 视为「无变化」，执行原命令（这是最后一道保险） |
| 环境里有 `RTK_DISABLED=1` | 完全不改写，执行原命令 |

上述任何一行都**不影响**沙箱语义：插件只覆写 `execute(spec)`，`resolve()`（沙箱 policy
印章）不动，兜底路径用未改动的 `spec` 调 `super.execute(spec)`。

只有 rtk 真正定义的四个码可能产出改写：0 与 3 把命令打在 stdout 上并被采纳，1 与 2 静默
透传，其余一律记一条警告后执行原命令。

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
- **rtk exit code 语义**（实测 rtk 0.50.0，2026-10-03 对照 0.51.0、2026-11-08 对照 1.1.0
  复核）：四个码分别是 **0 = 有改写输出且 allow 规则覆盖全链**、
  **1 = 无输出，未改写**、**2 = deny 规则命中，无输出**、
  **3 = 有改写输出，ask 规则命中或 allow 规则未覆盖全链**（含完全没有规则的情形）。
  `--help` 的文案曾被误读成「只要有改写就 exit 0」，那是条件句。**在没有 Claude 权限规则
  的机器上——DSH 桌面端安装即属此列——一切可改命令都是 exit 3 + stdout**，所以只认
  exit 0 的实现等于什么都没改写。0 和 3 都表示「这是改写结果」，1 和 2 都表示「保持原样」。
  已是 rtk 形态的命令在 0/3 下原样返回，这正是插件还要把结果与输入做比较的原因。
  Node 的 `execFile` 把子进程退出码放在 `err.code`（数字），spawn 失败（ENOENT）
  放字符串，所以判定统一用 `Number(err.code)`——Node 24 与 26 行为一致。
- **递归守卫**：插件不对「已经是 rtk 调用」的命令再做改写，这样 `rtk rewrite` 的输出可以
  安全交回，而不会让 rtk 改写自己。rtk 自己判断「已改写」的标记只是裸 `rtk ` 首词——
  大小写敏感、不认路径形式、不认 `.exe` 形式——所以守卫必须覆盖命令可能到达的更多形态
  （`rtk`、`rtk.exe`、`RTK.EXE`、二进制绝对路径、带引号的首词、`ENV=x` 前缀，以及复合
  命令后续段里的相同形态）。无论按哪种形态识别，上面那条「逐字节相等」的比较都保留为
  最后一道保险。
- **`RTK_DISABLED=1` 仅在插件 JS 层生效**（index.js 改写前自查，这也是它被写在
  [禁用](#禁用) 一节里、定位为「本插件自己的开关」的原因）。rtk 自己对 `RTK_DISABLED`
  的处理不同：它只在变量作为**命令文本里的 env 前缀**时生效
  （`RTK_DISABLED=1 git status` → exit 1 + stderr 一行警告）。把 `RTK_DISABLED=1` 作为
  **进程环境变量**设置并不能禁用 `rtk rewrite`——实测
  `RTK_DISABLED=1 rtk rewrite "git status"` 仍输出 `rtk git status` 且 exit 3。

## 安装 / 卸载

**前置**：DSH 桌面端 **0.2.0-rc.2+** 已捆绑 `dsh` 命令——在桌面端菜单栏点击
**"Manage dsh command"（管理 dsh 命令）** 完成安装即可，无需另装 Node/pnpm。

**安装**（必须钉精确版本：`@latest` 会被 release-age 校验回落到旧版）：

```powershell
dsh plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.1.7 --registry=https://registry.npmjs.org/
```

> 版本号由 CI 维护：每次推送 `main` 都会自动 patch 升版并发布，所以上面的数字
> 可能落后于最新发布。若安装报 404，先执行 `npm view dsh-pwsh-rtk-rewrite version`
> 查到最新版本，再用该精确版本号替换。

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

- **单命令**：环境变量 `RTK_DISABLED=1`——这是插件自己的 JS 层开关，改写前判定。
  注意上文提到的语义差异：rtk 自己只认**命令文本里**的 `RTK_DISABLED=` 前缀，
  不认进程环境变量。
- **自定义 rtk 二进制**：`RTK_BIN=/path/to/rtk`（或 `RTK_BIN=rtk.exe`）让插件指向一个
  不在 PATH 上的 rtk——不同版本、nightly 构建或包装脚本都行。插件就 spawn 这个路径，
  其它配置无需改动。
- **整行停用**：profile patch 中 override `rtk-pwsh-shell` 行 `disabled: true`，
  并恢复 `pwsh-sandbox` 行 `disabled: false`

## 已知局限

以下都是 rtk 改写规则的性质，不是插件缺陷。它们都不影响正确性——没有等价时原命令照跑：

- **pwsh cmdlet 与 shell 内建没有 rtk 等价**（`Get-ChildItem`、`Get-Process`、
  `Write-Output`、`echo`、`env` 等）。exit 1、静默、无 token 收益。
- **`sudo …` 不改写**——rtk 刻意透传 sudo 命令。
- **带文件重定向的命令不改写**（`git status > out.txt`），**命令替换也不改写**
  （`echo $(git status)`）；rtk 拒绝它无法确认的构造。
- **部分子调用的覆盖比工具本身的能力窄。** rtk 1.1.0 实测例子：`npm test` 与
  `pnpm test` 不改写（规则覆盖的是 `npm run/exec/x` 与
  `pnpm run/exec/i/install/list/ls/outdated`，不含裸 `test` 脚本别名）；
  `dotnet build` 会改但 `dotnet test` 不会；`vitest run` 返回 `rtk vitest`
  （`run` 被 rtk 吞掉）。这些都是 rtk 侧行为，结果都只是「执行原命令」。
- **`rtk rewrite` 不做恒等抑制。** 已是 rtk 形态的命令在 exit 0/3 下原样返回，抑制是
  调用方的责任——所以插件要把结果与输入比较。
- **管道里的 `wc` 段不改写**，尽管上游 `hooks/README.md` 把它列为 pipeline-safe；
  rtk 1.1.0 实测 `ls | wc -l` → exit 1。落后于实际的是上游文档，不是本插件。

## 验证

```powershell
node test.js               # 零依赖套件，8 组（项数随覆盖增加，以末尾统计行为准）
                           #   A rewrite 退出码契约（注入假 rtk）
                           #   B rtk 缺失 / 只告警一次
                           #   C 递归防护
                           #   D 失败安全
                           #   E 纯函数单测
                           #   F 复合命令与管道（真 rtk）
                           #   G 命令族冒烟（12 个族全覆盖，真 rtk）
                           #   H 模块契约（导出、package.json、patch 文件）
```

套件通过 `RTK_BIN` 注入一个**假 rtk**——一个 `rewrite` 脚本，退出码、stdout 与时序由
`FAKE_SCENARIO` 控制——因此每条契约分支都不依赖本机装的是哪个 rtk；另有调用日志可断言
「递归防护确实没有去 spawn rtk」。F、G 两组调**真** rtk（绝对路径），把它的当前输出
当 oracle，而非硬编码期望字符串，所以 rtk 演进时它们依然有效。宿主依赖
（`@deepseek-ai/dsh-pwsh-sandbox`）通过 `DSH_INSTALL_PACKAGE_JSON` 用假包顶替，
因此没有 `node_modules` 也能跑。

变异测试有两个环境变量：`RTK_TEST_TARGET` 把套件指向 `index.js` 的变异副本，
`RTK_TEST_SOFT=1` 把「与上游契约不符但非阻断」的发现从 FAIL 降级为 WARN。

运行时验证（三重证据互相印证）：

1. **harness 日志**：shell 命令执行时出现 `[rtk-rewrite] "orig" -> "rewritten"`
   （web 模式下落在启动重定向的日志文件，如 `dsh-web.log`）
2. **rtk history.db**（`C:\Users\<user>\AppData\Local\rtk\history.db`）：每次成功
   改写入库一条 `original_cmd → rtk_cmd` 记录
3. **`rtk gain`**：Total commands 计数随命令执行上升

> 注意：探针要选 rtk **必定认识**的命令（`git status`、`cat` 等）。
> pwsh 特有命令（`Write-Output`、裸 `Get-ChildItem` 等）rtk 报 exit 1 无等价，
> 静默且不入库——**无记录 ≠ 插件未工作**，这是排查时最容易踩的坑。

要单独确认某条命令的覆盖情况（在怀疑插件之前），直接问 rtk——这正是插件发出的调用：

```powershell
rtk rewrite "git status"          # exit 3，输出：rtk git status
rtk rewrite "Get-ChildItem"       # exit 1，无输出
```

## 文件结构

```
├── index.js          # RtkPwshExecutor（唯一源码：isRtkInvocation + rtkRewrite + execute）
├── cordis.patch.yml  # bundle patch：禁用 pwsh-sandbox + 插入 rtk-pwsh-shell
├── package.json      # dsh.bundle.patch 指向 patch 文件；无运行时 npm 依赖
├── test.js           # 零依赖验证套件（8 组）
├── README.md         # English
└── README_zh.md      # 中文（本文件）
```

## License

[MIT](LICENSE) © 2026 mengqi1436
