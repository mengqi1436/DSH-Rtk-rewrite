# rtk 1.2.1 `rewrite` 真实行为规范（REA 拆解 + 实机 oracle）

- 目标二进制：`C:/Users/Sjc/.local/bin/rtk.exe`，**rtk 1.2.1**，PE32+ amd64
- 二进制摘要（REA `inspect_artifact` / `inspect_pe_imports` / `inspect_pe_load_config`）：
  `sha256=54a980783fc18816b51f2100d714fbe1c7ce1c3f9d88d65f38dd17ac849a0c25`，18,560,000 字节
- 静态面事实：PE32+ / machine 0x8664 / 导入 kernel32.dll、ucrtbase 等标准 CRT+Win32，
  无 delay-import，无 PE 资源目录（`directories: []`, `resources: []`）——**规则表、过滤器、
  权限规则全部编译进 `.rdata`，不来自资源段**，所以「改配置改资源」这条路不存在。
- 本机 REA 分析后端现状：Ghidra 未配置（`GHIDRA_INSTALL_DIR` 未设）、Hopper 不支持 win32、
  IDA/Kuna 未配置 → **伪代码/反汇编层不可用**。REA 的进程捕获在 Windows 上亦不可用
  （`capability_unavailable`: Windows PTY 捕获尚未验证子进程清理）。
  因此本规范的行为面证据来自两条**可复现**的通道：
  1. 上游源码定点取证（`/d/Code/_upstream/rtk`，`origin/develop` = `dev-1.2.0-rc.620-147-g24ff2267`，
     即 v1.2.1 之后的 develop；`rewrite` 契约文件自 bd7f87e 起**零改动**）
  2. 本机 rtk 1.2.1 二进制的**进程级 oracle**（`rtk rewrite "<cmd>"` 的真实退出码与 stdout）
- 采集脚本：`.planning/2026-11-20-rtk-parity/probe-parity.mjs`（插件判定 vs rtk 真实输出对拍）

---

## ① 进程契约（插件唯一消费的面）

| 退出码 | stdout | 含义 | 插件应做 |
|---|---|---|---|
| 0 | 改写后的命令 | Allow：allow 规则覆盖全链；或 `RTK_REWRITE_HOST=openclaw` 把 3 抬成 0 | 采纳 stdout；注意 openclaw 下 `rtk git status` 也可能 exit 0 且**恒等回吐**，此时只能靠字符串比较抑制，不能靠退出码 |
| 3 | 改写后的命令 | Ask/Default：改写成立但需宿主确认（**无规则机器上的常态**） | 采纳 stdout |
| 1 | 空 | Defer：无等价 / 无可改段 / 被 exclude / 不可证构造 / RTK_DISABLED / shell wrapper 内 deny | 原命令照跑，**不告警** |
| 2 | 空或一条消息 | Deny：deny 规则先于一切判断命中；**若打印了消息，是 pipeline 规则拒绝/路由提示，不是命令行** | 丢弃 stdout，原命令照跑，**不告警** |
| 其他 | 任意 | 上游未定义 | 不采纳来源不明的 stdout，告警 |

源码依据：`src/hooks/rewrite_cmd.rs:110-125`（唯一一处 `process::exit(2)` 在 :122）。

> **行号归属声明（重要）**：本规范所有 `registry.rs` / `rewrite_cmd.rs` 行号，均对应
> `/d/Code/_upstream/rtk` 的 **`origin/develop` = `24ff22670aa03f94bc7eb8165179d9f4a91d28e5`**
> （`dev-1.2.0-rc.620-147-g24ff2267`），**不是**工作树 HEAD `bd7f87eb`。
> 两者差 4 行（`builtin_transparent_prefixes()` 的 doc-comment 增补所致）：
>
> | 符号 | origin/develop | 工作树 bd7f87e |
> |---|---|---|
> | 单命令恒等守卫 | `:832` | `:836` |
> | 复合段恒等守卫 | `:2004` | `:2008` |
> | `ROUTABLE_WRAPPER_PREFIXES` | `:1435` | `:1439` |
> | `SHELL_KEYWORD_PREFIXES` | `:1439` | `:1443` |
> | `MAX_PREFIX_DEPTH` | `:1581` | `:1585` |
>
> 引用时务必写明是哪一个 commit，否则「行号不对」的结论会取决于你比对的是哪棵树。

**二进制内嵌交叉验证**（`strings -a rtk.exe`，证明本机 1.2.1 的规则/契约确实编译进 `.rdata`
且与上游源码一致）：

| 常量 | 命中次数 |
|---|---|
| `RTK_DISABLED=` | 10 |
| `RTK_REWRITE_HOST` | 2 |
| `uv run`（ROUTABLE_WRAPPER_PREFIXES） | 3 |
| `nocorrect` / `noglob`（SHELL_KEYWORD_PREFIXES） | 各 1 |
| `transparent_prefixes` | 1 |
| `exclude_commands` | 5 |
| `pipeline rule` | 5 |

且二进制内嵌了完整的 `rewrite` help 文本，四条退出码的措辞与上游 `src/lib.rs` 逐字一致
（"0 - rewrite printed, allow rules cover every command…" 到 "3 - rewrite printed, an ask rule matched…"）。
这排除了「本机二进制的契约与上游源码不同步」这一可能。

**实测确认（必须实现的两条）**：
- `RTK_REWRITE_HOST=openclaw rtk rewrite "git status"` → **exit 0** + `rtk git status`
  （同一命令默认环境为 exit 3）。所以插件不能只认 3。
- `rtk rewrite "rtk git status"` → exit 3 + `rtk git status`（**恒等回吐，rtk 不做恒等抑制**）。

## ② 恒等守卫（rtk 自己的递归防护）

上游 `registry.rs:832`（单行入口）/ `:2004`（复合段入口）：

```rust
if !has_compound && (trimmed.starts_with("rtk ") || trimmed == "rtk") {
    return Some(trimmed.to_string());   // 原样返回
}
```

性质（逐条实测）：
- **大小写敏感且字面量**：`RTK git status` / `Rtk git status` → **exit 1**（根本不改）
- **不做 basename 归一**：`./rtk git status` / `rtk.exe git status` /
  `"C:/Users/Sjc/.local/bin/rtk.exe" git status` → **exit 1**
- **前导空白会被 trim**：`"  rtk git status"` → exit 3 + `rtk git status`
  （即：带前导空白的 rtk 命令，rtk 自己会回吐一份**去掉前导空白**的版本）。
  **这必须被采纳，不是可跳过的无害差异**：按 §① 契约，stdout ≠ 输入就是一次真实改写；
  插件若在此处短路 skip，就会丢掉这次改写。故 `isRtkInvocation` 必须在分段判定**之前**
  先判 `text !== text.trim()` → 返回 false。
- **仅对非复合命令生效**：`rtk git status && git log` → 落到 `rewrite_compound`，
  首段原样、后续段照常改写 → exit 3 + `rtk git status && rtk git log`
- **混合段仍会改写**：`ls && rtk git status` → `rtk ls && rtk git status`；
  `rtk git status || ls` → `rtk git status || rtk ls`

## ③ 插件 `isRtkInvocation` 与上游守卫的对拍结论

对拍 47 条用例（`probe-parity.mjs`），**真实分歧仅 1 条**：

| 用例 | 插件判定 | rtk 实际 | 影响 |
|---|---|---|---|
| 空白变体（4 类，见下） | **修复前** skip=true（不 spawn） → **修复后** skip=false | exit 3，改写为 `rtk git status` | 修复前漏一次「去空白归一化」；**这是一次真实改写，必须采纳**（stdout ≠ 输入即改写），不能以「语义相同」放过 |

**该分歧实为 4 类空白变体**，逐条实测均为 exit 3 + `rtk git status`（上游比 `trim` 后的行、
回吐的也是 `trim` 后的串）：

| 形态 | 例 |
|---|---|
| 前导空白 | `"  rtk git status"`、`"\trtk git status"`、`"\nrtk git status"` |
| 尾随空白 | `"rtk git status "`、`"rtk git status  "`、`"rtk git status\n"` |
| 前导+尾随 | `"\n rtk git status"` |
| 裸 rtk 带空白 | `" rtk"`、`"rtk "` |

修复方式：`isRtkInvocation` 在分段判定**之前**先做 `text !== text.trim()` → 返回 false，
让 rtk 自己给出归一化结果。无空白形态（`"rtk git status"`）仍正常跳过。

**修复后复测：47 条里分歧 0 条**（`probe-parity.mjs`）。另有 `lead-verify.mjs` 的
113 条加宽对拍（复合/管道/后台/多行、4 类空白、8 种 rtk 写法、9 种透明前缀、20 类拒绝改写），
不变式违规同样 **0**，「多一次 spawn」43 条（无害）。修法是 `isRtkInvocation` 在分段判定
之前先 `text !== text.trim()` 短路返回 false。

其余「插件宽于上游」的用例（`RTK git status`、`./rtk ...`、`rtk.exe ...`、
`C:/.../rtk.exe ...`、`FOO=1 rtk ...`、`RTK_DISABLED=1 rtk ...`）方向是
「插件跳过 → rtk 本来就 exit 1 不改写」，**结论一致、无漏改写**，只是省了一次 spawn。
`rtk=1 ls`、`rtkx ...`、`rtk-helper ...`、`sudo rtk ...` 双方都判「不是 rtk 调用」。

## ④ 复合 / 管道 / 多行（由 rtk 处理，插件只整条透传）

| 输入 | 实测 |
|---|---|
| `git status && git log` | exit 3 → `rtk git status && rtk git log` |
| `git status \|\| git log` | exit 3 → `rtk git status \|\| rtk git log` |
| `git status;git log` / `;;` / `;;&` | 各自逐段改写 |
| `git status & git log`（后台） | exit 3 → `rtk git status & rtk git log` |
| `sleep 1 & git status` | exit 3 → `sleep 1 & rtk git status` |
| `git status \| head -5` | exit 3 → 只改 producer |
| `git status \|& git log` | **exit 1**（不支持 `\|&`） |
| `ls \| wc -l` / `git log \| wc -l` | **exit 1**（`wc` 非 pipeline-safe） |
| 多行 `git status\ngit log` | exit 3 → 两行各自改写 |
| 行继续符 `git status \\\ngit log` | exit 3 → `rtk git status git log`（**续行折叠成空格**） |
| `echo "a && b" && git status` | exit 3 → 引号内 `&&` 未被切 |

## ⑤ 透明前缀（rtk 会「穿透」包装命令再改写）

上游常量（`registry.rs:1435-1456`、`:1575-1584`）：

- `ROUTABLE_WRAPPER_PREFIXES` = `["uv run"]`
- `SHELL_KEYWORD_PREFIXES` = `["noglob", "command", "builtin", "exec", "nocorrect"]`
- `PROCESS_WRAPPERS` = `timeout`（`-s -k --signal --kill-after` 取值，1 个位置参数）、`time`（`-f -o --format --output`）等
- 深度上限 `MAX_PREFIX_DEPTH = 10`

实测：`uv run pytest` → `uv run rtk pytest`；`timeout 30 git status` → `timeout 30 rtk git status`；
`time git status` → `time rtk git status`；`noglob/command/exec/nocorrect git status` → 各自保留前缀 + `rtk`；
`nice git status` → `nice rtk git status`（走 PROCESS_WRAPPERS）；`direnv exec . git status` → exit 1（**不在内置表**）。

**插件必须做到**：这些命令**不得**被 `isRtkInvocation` 误判为「已是 rtk 调用」而跳过。

实测（与 §⑦ 第 1 条一致，本条即为该条的出处）：`uv run rtk git status`、
`timeout 30 rtk git status`、`time rtk git status`、`nice rtk git status`、
`noglob/command/exec/nocorrect rtk git status` → rtk **全部 exit 1**
（剥前缀后内部已是 `rtk`，落进恒等守卫，不改写）；
`bundle exec rtk git status`、`poetry run rtk git status`、`env rtk git status` 同样 exit 1。
即：插件对这些命令跳过不会漏改写，但这是「rtk 自己也不改」的结果，不是插件推导出的结论。

## ⑥ 明确拒绝改写（exit 1，静默）

`$(...)` 命令替换、`> file` / `>> file` 写重定向、heredoc、`$((` 算术展开、
`$$`、不平衡引号/括号、`{ ...; }` / `( ... )` 分组、`if/for/while/until/case/function` 等
`BLOCK_KEYWORDS` 打头的多行块、`sudo ...`（上游刻意不剥 sudo，#146）、
`cat` 的非 `-n` 旗标（`cat -v` exit 1，`cat -n` → `rtk read -n`）。

**注意** `2>&1` / `2>/dev/null` **不是**写重定向，允许改写（`git status 2>&1` → `rtk git status 2>&1`）。

## ⑦ 原未决项已全部实测定论

1. **透明前缀 + rtk 恒等式**：`uv run rtk git status`、`uv run rtk pytest`、`timeout 30 rtk git status`、
   `time rtk git status`、`nice rtk git status`、`noglob/command/exec/nocorrect rtk git status`
   → **全部 exit 1**。即 rtk 剥离透明前缀后发现内部已是 `rtk`，落进恒等守卫，不改写。
   **结论**：插件对这些命令跳过不会漏改写。
2. **`RTK_REWRITE_HOST` 取值对退出码的影响**（`git status` 为探针）：

   | 取值 | 退出码 |
   |---|---|
   | 未设 / `claude` / `codex` / `pi` / `hermes` / `omp` / `opencode` | **3** |
   | `openclaw` | **0** |

   且 `RTK_REWRITE_HOST=openclaw` 下：`Get-ChildItem` 仍 exit 1（无等价不变）、
   `rtk git status` 变 exit 0 + `rtk git status`（恒等回吐，插件靠字符串比较抑制）。
   **结论**：只有 `openclaw` 会把 3 抬成 0；插件必须同时认 0 与 3，当前实现已满足。
3. **exit 2 带消息**：本机无 `~/.claude/settings*.json` 也无 `~/.rtk/config.toml`，
   无法构造 pipeline 规则拒绝，未能实测。插件「exit 2 一律丢弃 stdout」是保守且正确的方向：
   上游 help 明说该消息是拒绝/路由提示而**不是命令行**。
