# docs-changes.md — README.md / README_zh.md 更新说明（task-5）

日期：2026-11-08
范围：只改 `README.md`、`README_zh.md`，本文件记录改动与依据。
未触碰 `index.js` / `test.js` / `package.json` / `cordis.patch.yml`。

## 依据来源

| 来源 | 用途 |
|---|---|
| `.planning/2026-11-08-rtk-upstream-sync/rtk-capabilities.md` | rewrite 契约（四码语义、恒等返回、复合/管道、`RTK_DISABLED` 真实语义、版本三轨不一致、命令族清单） |
| `.planning/2026-11-08-rtk-upstream-sync/dsh-plugin-contract.md` | 子类化合规性、`ShellExecSpec` 10 字段、peer 判定语义、0.2.1→0.2.2-rc.1 无 breaking |
| `.planning/2026-11-08-rtk-upstream-sync/impl-changes.md` | `isRtkInvocation` 新纯函数、exit 2/3 显式分支、`RTK_DISABLED` 注释纠偏 |
| `index.js`（改造后，244 行，实测 mtime 2026-11-08 14:36） | 最终代码即事实源：`isRtkInvocation` 分段判定、exit 0/1/2/3 显式分支、未定义码不采用 stdout |
| `test.js`（改造后，685 行）＋ `node test.js` 实跑 | 8 组 214 项 `ALL PASS`；假 rtk 注入、`RTK_TEST_TARGET`/`RTK_TEST_SOFT` |
| 本机实测 `rtk rewrite`（rtk 1.1.0，2026-11-08） | 命令族表全部条目、无等价清单、局限清单逐条验证 |
| 上游源码 `/d/Code/_upstream/rtk`（develop，HEAD `bd7f87e`，tag `dev-1.2.0-rc.620`） | `src/cmds/` 12 目录、`src/discover/rules.rs` 规则、`src/hooks/rewrite_cmd.rs` 退出码、`src/filters/` 62 个 TOML |
| 上游源码 `/d/Code/_upstream/dsh`（master，HEAD `fcc0ad4`，0.2.2-rc.1） | `packages/shell/pwsh-sandbox/src/index.ts` 仍是 `override execute`；`ShellExecSpec` 字段未变 |

## 一、校正的过时内容

### 1. rtk 版本要求（两版都改）

- **改前**：`rtk ≥ 0.50.0`；「契约已于 2026-10-03 对照 rtk 0.51.0 复核」。
- **改后**：改为「`rtk rewrite` 子命令可用」，并给出上游参考 hook 自述的下限
  `Requires: rtk >= 0.23.0`；契约复核记录补上 2026-11-08 的 rtk 1.1.0。
- **为什么**：插件只消费进程契约（退出码 + stdout），不存在需要 0.50.0 的特性；
  原来的 `≥ 0.50.0` 是把「当时测过的版本」写成了「最低版本」，属于无依据收紧。
- **依据**：`rtk-capabilities.md` §5.3（1.1.0 已具备上游 HEAD 全部 rewrite 契约特性）；
  `hooks/claude/rtk-rewrite.sh:4`（`Requires: rtk >= 0.23.0`）。

### 2. exit code 语义描述（两版都改，改动最大的一处）

- **改前**：「a supported command — including one already in rtk form — exits 3 with the
  command on stdout; no equivalent exits 1 with no output」，并把 `--help` 说成
  「claims exits 0」。
- **改后**：完整写出四码语义（0 = 有改写且 allow 覆盖全链；1 = 无改写；2 = deny 命中；
  3 = 有改写但需宿主确认/无规则），并明确指出 `--help` 原文是**条件句**、
  在无 Claude 权限规则的机器上（DSH 桌面端安装即属此列）**一切可改命令都是 exit 3**。
  同时说明 0/3 都携带改写、1/2 都保持原样、rtk 不做恒等抑制所以调用方必须比对。
- **为什么**：原描述把 exit 3 写成"支持的命令"的一般情形，容易让读者以为 exit 0 才是
  常规成功；而 `--help` 的措辞曾被误读成"有改写就 exit 0"，这会让只认 exit 0 的实现
  完全失效。这是本次最需要纠正的认知。
- **依据**：`rtk-capabilities.md` §1.2/§1.3（含 `rewrite_cmd.rs:111-124`、
  `lib.rs:1069-1093` 的原文对照）；`impl-changes.md` #3/#4（代码里已改成显式分支）；
  本机 rtk 1.1.0 实测（`git status` → exit 3）。

### 3. 递归守卫的描述（两版都改）

- **改前**：流程图写 `command starts with "rtk "/"rtk.exe " ?`。
- **改后**：改为「command already an rtk invocation ?」，并把判定范围写清：
  `rtk`、`rtk.exe`、`RTK.EXE`、二进制绝对路径、带引号首词、`ENV=x` 前缀、复合命令后续段。
- **为什么**：改造后 `isRtkInvocation` 是分段感知的纯函数，旧的 `startsWith` 描述已不成立；
  且必须让用户知道「复合命令里出现 rtk 不会导致整串跳过」
  （`ls -la && rtk git status` 仍会被改写）。
- **依据**：`index.js:101-168`（`splitSegments`/`firstWord`/`isRtkSegment`/`isRtkInvocation`）；
  `impl-changes.md` #2 与其中的 29 例纯函数矩阵。
- **注意**：`rtk-capabilities.md` §6.1 提示上游自己的守卫是大小写敏感、仅字面 `rtk `，
  因此本插件的判定**故意比上游宽**——这句已写进 `index.js` 注释，README 侧也点明
  「byte-identical 比较保留为最后一道保险」。

### 4. `RTK_DISABLED` 的定位（两版都改）

- **改前**：「rtk's own convention; the plugin honors it at the JS layer」。
- **改后**：明确写成「**插件自己的开关**」，并单独说明 rtk 侧的真实语义：
  只有作为**命令文本里的 env 前缀**才生效（exit 1 + stderr 一行警告），
  作为**进程环境变量**对 `rtk rewrite` 无效（实测
  `RTK_DISABLED=1 rtk rewrite "git status"` 仍输出 `rtk git status` 且 exit 3）。
- **为什么**：原措辞把它写成 rtk 的约定，会让用户以为设了环境变量 rtk 自己也会停——
  它不会。这是用户最容易踩的认知陷阱之一。
- **依据**：`rtk-capabilities.md` §4.1/§4.2；本机实测；`impl-changes.md` #6（注释纠偏）。

### 5. 验证一节（两版都改）

- **改前**：`node test.js` 描述为「rtkRewrite 判定逻辑自检 + 模块加载」，并称「加载
  devDependency 中的 sandbox 包副本」。
- **改后**：如实写出 8 组 214 项、假 rtk 注入机制、F/G 组用真 rtk 且以其输出为 oracle、
  宿主包用 `DSH_INSTALL_PACKAGE_JSON` 打桩（无 `node_modules` 也能跑）、
  `RTK_TEST_TARGET`/`RTK_TEST_SOFT` 两个变异测试变量。
- **为什么**：旧描述对应的是被替换掉的旧测试（抄一份 rtkRewrite 自己测自己、依赖
  devDependency 安装）。新测试的运行前提与失败语义完全不同，用户按旧描述排查会走错路。
- **依据**：`test.js` 文件头 1-19 行的设计说明；实跑 `node test.js` →
  `总计 214 项：通过 214 / 失败 0 / 与契约不一致 0` / `RESULT: ALL PASS`。

### 6. 文件结构一节（两版都改）

- index.js 注释：`rtkRewrite + execute interception` → `isRtkInvocation + rtkRewrite + execute`。
- test.js 注释：`minimal self-check` → `zero-dependency verification suite (8 groups)`。
- **依据**：改造后的文件实际内容。

## 二、新增内容

### 7. 「装了插件就对全部命令族生效」——放在开篇（两版都加）

开篇示例之后新增一段：**No allow-list, no per-command config, nothing to register.**
并解释原因（整串转发、rtk 返回什么用什么、插件不含规则表）。这是任务点名的
「用户最关心的一句话」，因此不埋在正文里。

### 8. `## Supported command families` / `## 支持的命令族`（两版新增整节）

- 12 个族的分组表（cloud / dotnet / git / go / js / jvm / php / python / ruby / rust /
  scala / system），每族给代表性命令。
- 说明：除 12 个源码族外还有 `src/filters/*.toml` 的 62 个 TOML 过滤器，走同一入口。
- 说明：无等价命令返 exit 1 原样执行，实际就是 pwsh cmdlet / shell 内建 + rtk 刻意放过的
  情形（`sudo`、写重定向、`gh --json`、非 `-n` 的 `cat`）。
- **为什么**：原 README 完全没有命令范围说明，用户无法判断"装了到底省不省"。
- **依据**：
  - 族数：`ls -d /d/Code/_upstream/rtk/src/cmds/*/` = 12 个目录，
    `src/cmds/mod.rs` 12 行 `pub mod`，两边一致（**注意：任务简报与部分二手资料说
    "13 个命令族"，实际是 12 个目录 + `mod.rs` 也只有 12 条；本文件按实测的 12 写。
    详见下方「四、与任务简报的偏差」**）。
  - 每族命令：`src/discover/rules.rs` 的 `pattern` + `rtk_cmd` 配对抽取，
    再逐条用本机 `rtk rewrite` 验证返回非空。
  - TOML 数量：`ls src/filters/*.toml | wc -l` = 62。
  - 无等价清单：本机实测 `Get-ChildItem` / `Get-Process` / `Write-Output` / `echo` / `env`
    全部 exit 1；`rules.rs:1140-1188` 的 `IGNORED_PREFIXES`。

### 9. 「rtk version compatibility」/「rtk 版本兼容性」（两版新增整节）

- 三行版本探测表（0.50.0 / 0.51.0 / 1.1.0）。
- 明确点出：上游 `develop` 的 tag `dev-1.2.0-rc.620`、`Cargo.toml` 的 `0.49.0`、
  本机 `1.1.0` 是**三套不同编号轨**，不是可比 semver，所以「1.1.0 落后于 1.2.0-rc」
  是错误读法；要看逐命令实测能力。
- 明确点出：**命令覆盖随 rtk 升级自动增长，插件无需同步更新；插件单独升级也不会扩大覆盖**。
- **依据**：`rtk-capabilities.md` §5.1（三轨版本对照表）/§5.3（1.1.0 已具备 HEAD 特性）；
  上游 `Cargo.toml:25`、`CHANGELOG.md:8`、`git tag` 实测。

### 10. `### Failure safety` / `### 失败安全语义`（两版新增小节）

独立的 7 行表格，穷举所有失败路径对应的行为：ENOENT（警告一次）、exit 1（静默）、
exit 2（透传）、超时（杀子进程）、未定义码/崩溃（**丢弃 stdout**）、恒等结果（执行原命令）、
`RTK_DISABLED=1`。并声明沙箱语义不受任何一行影响。
- **依据**：`index.js:185-220`（`rtkRewrite` 分支）与 `index.js:222-243`（`execute`）；
  `rtk-capabilities.md` §6.2；`dsh-plugin-contract.md` §1.3（spec 10 字段全部保留）。

### 11. `## Known limitations` / `## 已知局限`（两版新增整节）

6 条实测局限，全部标注是 rtk 侧行为、不影响正确性：
`npm test`/`pnpm test` 不改写、`dotnet test` 不改写、`vitest run` 被吞成 `rtk vitest`、
`sudo` 不改写、写重定向/命令替换不改写、rtk 不做恒等抑制、
以及上游 `hooks/README.md` 声称 `wc` 是 pipeline-safe 但实测 `ls | wc -l` → exit 1
（**文档落后于代码，以实测为准**）。
- **为什么**：原 README 只有一个「排查坑」提示，没有系统性的局限说明；用户遇到不改写
  时容易误判为插件故障。
- **依据**：本机 rtk 1.1.0 实测逐条；`rtk-capabilities.md` §5.4（含 `wc` 文档不一致）。

### 12. `RTK_BIN` 用法（两版都补）

从「Requirements 里一句」提升为 `## Disabling` / `## 禁用` 下的独立条目，
说明它可以把插件指向非 PATH 的 rtk（不同版本 / nightly / 包装脚本）。
- **依据**：`index.js:92`；`rtk-capabilities.md` §4「`RTK_BIN` 在上游不存在，是插件私有变量」。

### 13. 单命令自查方法（两版都补）

Verification 末尾加两条可直接复制的 `rtk rewrite` 调用，让用户在怀疑插件之前先问 rtk。
- **依据**：这正是插件发出的同一条调用（`index.js:189`）。

### 14. `0.2.2-rc.1` 兼容性条目（两版都加）

在 Compatibility / 兼容性验证 一节按既有格式补一条：四个契约面无 breaking
（`ShellExecSpec` 10 字段、`override execute`、patch 文法、peer 判定），peer 范围已覆盖；
并如实标注两条取证限制（`--depth 1` 浅克隆、无 per-package CHANGELOG；
`devDependencies` 仍钉 `0.2.1-rc.3` 但不参与运行时）。
- **依据**：`dsh-plugin-contract.md` §0 / §1.3 / §6.2 / §6.3 / §7.1；
  上游 `packages/shell/pwsh-sandbox/src/index.ts:52,96`（本地直读确认 `override` 仍在）；
  peer 范围覆盖 0.2.2-rc.1 用 `test.js` 同款 semver 实现独立复算确认。

### 15. 0.2.1-rc.3 条目的 test.js 描述同步（两版都改）

原文「`test.js` now loads the devDependency copy of 0.2.1-rc.3」已不成立（改为打桩注入），
改成如实表述：本条核查当时仍以 devDependency 加载，套件此后改为注入假宿主包。
- **依据**：`test.js` 现用 `DSH_INSTALL_PACKAGE_JSON`。

## 三、刻意未改的部分

| 位置 | 为什么不动 |
|---|---|
| 开篇 2026-09-25 的实测示例（dsh 0.1.7-rc.2 + rtk 0.50.0） | 那是历史记录，保留原样并**新增一行** 2026-11-08 的复测结论，比改写历史记录更可信 |
| `## How It Works` 里 patch 两行规则（disable + insert） | `dsh-plugin-contract.md` §7.1 #6/#7 判定仍完全合规，无改动必要 |
| `## Install / Uninstall` 全文 | 安装流程与版本号未变；`@1.1.7` 的「可能落后于最新发布」说明本身已自我覆盖 |
| 内核包解析五条探测链 | 未改动；`index.js:58-87` 仍是同一顺序 |
| 0.2.0 / 0.2.0-rc.2 / 0.2.1 三条历史兼容性记录 | 历史核查结论，未失效，不动 |
| 三处 `SHA256 BED19D2C…` / `252 lines` 的具体值 | 属历史核查证据，本轮没有重新比对那些 npm 包，不能改也不能删 |

## 四、与任务简报的偏差（如实说明）

1. **命令族数量：简报说 13，实测是 12。**
   `ls -d /d/Code/_upstream/rtk/src/cmds/*/` 返回 12 个目录
   （`cloud dotnet git go js jvm php python ruby rust scala system`），
   `src/cmds/mod.rs` 也只有 12 行 `pub mod`。简报列举的名字本身也是这 12 个。
   文档按 **12** 写，并把这个数字的取证方式写进正文（目录列表与 `mod.rs` 一致）。
   如果 Lead 手上有 13 的来源（例如把 `src/cmds/` 根或某个子目录计入了），
   请指出，我按来源改。
2. **`vitest run` 的吞字现象**：简报未提，但 `rtk-capabilities.md` §5.4 记录了，
   本机复测确认（`vitest run` → `rtk vitest`）。已写入「已知局限」并标注是 rtk 侧行为。
3. **`rtk ≥ 0.50.0` 下修为「`rtk rewrite` 可用」**：属于对既有说法的**放宽**，
   依据是插件只用进程契约 + 上游 hook 自述 `>= 0.23.0`。若 Lead 希望保守保留
   `≥ 0.50.0`（表示"只在 0.50.0+ 验证过"），可一句话改回——但那样就必须把
   「已验证版本」与「最低要求版本」分开表述，否则仍是误标。

## 五、自检

```
$ node test.js
总计 214 项：通过 214 / 失败 0 / 与契约不一致 0
RESULT: ALL PASS
```

- 两版标题层级一一对应：各 11 个 `##` + 2 个 `###`，共 13 个标题，顺序与措辞逐条对应
  （命令族→支持的命令族、Compatibility→兼容性验证、Requirements→环境要求、
  rtk version compatibility→rtk 版本兼容性、How It Works→工作原理、
  Failure safety→失败安全语义、Key Design Decisions→关键设计决策、
  Install / Uninstall→安装 / 卸载、Disabling→禁用、Known limitations→已知局限、
  Verification→验证、File Layout→文件结构、License→License）。
- 两版新增的 6 处小节（命令族、版本兼容性、失败安全、已知局限、0.2.2 条目、
  单命令自查）内容逐条对应，无「一版写了一版漏」。
- 本次文档任务自身只产生 3 个 `M`/`??` 条目：`README.md`、`README_zh.md`、
  `.planning/2026-11-08-rtk-upstream-sync/docs-changes.md`。
  `git status` 中 `index.js` / `test.js` 的 `M` 来自并行的实现与测试任务，
  不是本任务所改（本任务全程未写过这两个文件）。
