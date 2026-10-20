# rtk 1.0.1 `rewrite` 四档契约核验

核验对象：本机 `rtk 1.0.1`（`C:\Users\ASUS\.local\bin\rtk.exe`，PATH 中），与上游 tag `v1.0.1`（`4ef8730c`）源码。
DSH 侧对象：`@deepseek-ai/dsh-shell@0.2.1-rc.2`、`@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.2`。
核验时间：2026-10-20。所有命令在 Windows PowerShell 7（`pwsh`）下执行。

---

## 0. 与任务假设冲突的发现（最重要的三条）

### 0.1 【冲突】`rtk rewrite` 的 exit 2 **只有"无输出"一种情形，"有输出的 exit 2"不存在**

任务假设 exit 2 有两种子情形：无输出（规则 deny）与有输出（pipeline deny/route 消息）。**后半句在 `rtk rewrite` 上不成立。**

源码证据（`v1.0.1:src/hooks/rewrite_cmd.rs`，`run()` 的全部四个出口）：

```rust
match decided {
    HookDecision::AllowRewrite(rewritten) => { print!("{}", rewritten); Ok(()) }      // exit 0
    HookDecision::AskRewrite(rewritten)   => { print!("{}", rewritten); exit(3) }     // exit 3
    HookDecision::Deny                    => std::process::exit(2),                   // exit 2：不打印任何东西
    HookDecision::Defer                   => std::process::exit(1),                   // exit 1：不打印
}
```

`Deny` 分支直接 `exit(2)`，`rewrite_cmd.rs` 全文没有任何"打印消息后再 exit 2"的路径。
同一文件的文档表也只写 `2 | (none) | Deny rule matched — hook defers to the host's native deny`。

`rtk rewrite --help` 里那句 "A message printed: an rtk pipeline rule denied or routed the command" 描述的是 **`rtk hook <agent>` 进程内路径**（hook 协议用 JSON 表达决策，退出码恒 0），不是 `rewrite`。1.0.0 CHANGELOG 的 `2b96061 fix(hooks): pipeline hook rules act on Claude Code only` 印证了这个作用域限定。

实测对照（同一目录、同一 pipeline 文件）：

```
$ rtk rewrite "rm -rf /tmp/x"
exit=1   stdout=<空>

$ '{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/x"}}' | rtk hook claude
exit=0
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"rm blocked by probe pipeline"}}
```

`rtk pipeline explain` 明确认定该规则命中 `rule block-rm -> action deny`，`rtk pipeline show` 也显示它排在继承规则之前——但 `rewrite` 仍返回 1。`decision.rs` 全文没有出现 `pipeline` 字样，`decide()` 只消费 `PermissionVerdict`。

**对插件的后果**：exit 2 的 stderr 里**绝不会有 deny 理由**，只有 `[rtk] No hook installed…` 噪声或空。任何"从 stderr 取 deny 消息"的实现都会把噪声当理由（见 §1.6 对当前 `index.js:197` 的具体影响）。

### 0.2 exit 0 与 exit 3 的 **stdout 完全相同**，只有退出码能区分

```
exit 0 → stdout: rtk git status
exit 3 → stdout: rtk git status
```

所以插件不能凭 stdout 判断"是否已授权"，必须看退出码。当前实现已如此，记录在案以免后续被"简化"掉。

### 0.3 `rtk rewrite` 的规则来源是 **Claude Code 的 settings**，不是 rtk 自己的配置

`rewrite_cmd.rs` 的注释原文：

> `rtk rewrite` has one rule source for every delegate that shells out to it -- hermes, omp, opencode, openclaw, pi -- and that is `~/.claude`'s rules. The in-process `rtk hook <agent>` path is host-parameterized instead (`permissions::Host`).

实测：在 cwd 及其**祖先目录**的 `.claude/settings.json` / `.claude/settings.local.json` 写 `permissions.allow` / `permissions.deny` 即可改变退出码（见 §1.3、§1.4）。rtk 自身的 `config.toml` 不参与 allow/deny 判断（只参与 `[hooks] exclude_commands` 等）。

**当前工作区的实际影响**：`E:\Code\dsh\Rtk\.agents\worktrees\feat\rtk-1.0-rewrite-contract` 及其全部祖先目录（直到 `E:\`）**都不存在 `.claude` 目录**，`~/.claude/settings.json` 也没有 `permissions` 段。所以在本机默认环境下，插件只会遇到 exit 1 / exit 3，**永远不会遇到 exit 0 或 exit 2**。

---

## 1. 四档实测

### 1.0 权威定义：`rtk rewrite --help` 全文抄录

命令：`rtk rewrite --help`（exit 0，输出在 stdout）

```
Rewrite a raw command to its RTK equivalent (single source of truth for hooks)

Exit codes (a hook must handle all four). The rules are Claude Code's permission rules, checked against every command in a chain.

0 - rewrite printed, allow rules cover every command: the hook may auto-allow it. RTK_REWRITE_HOST=openclaw, for a delegate that gates commands itself, turns every 3 but an ask rule's into 0, so a hook that auto-allows on 0 runs rtk with that variable unset.

1 - nothing printed, no rewrite (no RTK equivalent, nothing left to rewrite, a command excluded in config, a construct RTK does not rewrite such as `$(...)` or a file redirect, or a deny rule matched inside a shell wrapper's script): run the command unchanged.

2 - a deny matched (checked before anything else). Nothing printed: a deny rule, defer to the agent's own deny. A message printed: an rtk pipeline rule denied or routed the command, block it with that message.

3 - rewrite printed, an ask rule matched or allow rules do not cover every command, including when there are no rules at all: use the rewrite and defer approval to the host.

Compare the rewrite with the original: a command already in RTK form can come back as itself under 0 or 3.

Exit 3 is still a rewrite, so `REWRITTEN=$(rtk rewrite "$CMD") || exit 0` drops it.

See hooks/claude/rtk-rewrite.sh in the RTK repository for reference handling.

Usage: rtk.exe rewrite [OPTIONS] [ARGS]...

Arguments:
  [ARGS]...
          Raw command to rewrite (e.g. "git status", "cargo test && git push") Accepts multiple args: `rtk rewrite ls -al` is equivalent to `rtk rewrite "ls -al"`

Options:
      --skip-env
          Set SKIP_ENV_VALIDATION=1 for child processes (Next.js, tsc, lint, prisma)

  -h, --help
          Print help (see a summary with '-h')
```

注意：**没有 `--quiet`**，也没有任何退出码相关的开关；唯一的环境变量钩子是 `RTK_REWRITE_HOST`。

### 1.1 四档结论表（全部实测）

| 档位 | 触发条件 | exit | stdout | stderr | 复现方式 |
|---|---|---|---|---|---|
| **0** | `~/.claude` 规则里 `allow` 覆盖**全部**命令 | 0 | `rtk <cmd>` | 仅 hook 噪声 | §1.3 |
| **1** | 无等价命令 / 已无改写 / config 排除 / 不 rewrite 的构造 / wrapper 脚本内 deny | 1 | 空 | 仅 hook 噪声 | §1.2 |
| **2** | `~/.claude` 规则里 `deny` 命中（**必定无 stdout**） | 2 | 空 | 仅 hook 噪声 | §1.4 |
| **3** | 无任何规则（默认）／ask 命中／allow 未覆盖全部 | 3 | `rtk <cmd>` | 仅 hook 噪声 | §1.1 |

四档均验证到位。"有输出的 exit 2" **未能复现**，原因见 §0.1 与 §6。

### 1.2 exit 1：无等价命令

```powershell
$t = Join-Path $env:TEMP "final"; $A = Join-Path $t "plain"
New-Item -ItemType Directory -Force -Path $A | Out-Null
Push-Location $A
rtk rewrite "echo hi" 1>$t\o 2>$t\e; "exit=$LASTEXITCODE"
Pop-Location
```

真实输出：

```
[1档-无等价] cmd=echo hi
  exit=1
  stdout=<>
  stderr=<[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings>
```

`Get-ChildItem` 同样 exit 1（PowerShell 命令没有 rtk 等价物）。

### 1.3 exit 0：allow 规则覆盖全部命令

关键：裸 `Bash` **不**生效（实测 exit 3），必须是带括号的通配形式。以下写法实测均得到 exit 0：`Bash(*)`、`Bash(:*)`、`Bash(*:*)`、`Bash(**)`、`Bash(git:*)`、`Bash(git status)`；`Shell(*)` 与裸 `Bash` 不生效。

```powershell
$B = Join-Path $env:TEMP "final\allow"
New-Item -ItemType Directory -Force -Path "$B\.claude" | Out-Null
'{ "permissions": { "allow": ["Bash(*)"] } }' | Set-Content "$B\.claude\settings.json" -NoNewline
Push-Location $B
rtk rewrite "git status" 1>$env:TEMP\final\o 2>$env:TEMP\final\e; "exit=$LASTEXITCODE"
Pop-Location
```

真实输出：

```
[0档-allow全覆盖] cmd=git status
  exit=0
  stdout=<rtk git status>
  stderr=<[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings>
```

补充实测：规则放在 cwd 的 `.claude/settings.local.json` 同样生效；从 cwd 的**子目录**（`$B\sub\deeper`）运行时依然生效，说明 rtk 会向上查找 `.claude`。

旁证（不改任何文件即可观察 3→0）：`RTK_REWRITE_HOST=openclaw` 把默认 ask 渲染成 0。

```powershell
$env:RTK_REWRITE_HOST="openclaw"; rtk rewrite "git status"   # exit=0, stdout=rtk git status
Remove-Item Env:\RTK_REWRITE_HOST
```

这不是"allow 规则"，只是 `ApprovalOwner::Delegate` 的渲染改写（`decision.rs:110-113`），但机制上也能造出 exit 0，供对照。

### 1.4 exit 2（唯一可复现的子情形）：规则 deny，无输出

```powershell
$C = Join-Path $env:TEMP "final\deny"
New-Item -ItemType Directory -Force -Path "$C\.claude" | Out-Null
'{ "permissions": { "deny": ["Bash(rm:*)"] } }' | Set-Content "$C\.claude\settings.json" -NoNewline
Push-Location $C
rtk rewrite "rm -rf /tmp/x" 1>$env:TEMP\final\o 2>$env:TEMP\final\e; "exit=$LASTEXITCODE"
Pop-Location
```

真实输出：

```
[2档-规则deny] cmd=rm -rf /tmp/x
  exit=2
  stdout=<>
  stderr=<[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings>

[对照-deny不影响无匹配命令] cmd=git status
  exit=3
  stdout=<rtk git status>
```

即 deny 精确作用于匹配的命令，未匹配的命令照常走 3。

**故意把 settings.json 写坏**时的行为（可作为 deny 健壮性参考）：

```powershell
'{ "permissions": { "allow": [ }' | Set-Content "$B\.claude\settings.json"
rtk rewrite "git status"
```

真实输出（stderr）：

```
[rtk] warning: failed to parse permissions from C:\Users\ASUS\AppData\Local\Temp\rtk-rule-probe\.claude\settings.json
```

exit 为 3（退回"无规则"），JSON 坏掉不会静默降级成 allow。这也直接暴露了 rtk 读取的**具体文件路径**，是定位规则来源最快的手段。

### 1.5 exit 3：默认无规则

```powershell
Push-Location (Join-Path $env:TEMP "final\plain")
rtk rewrite "git status"
```

真实输出：

```
[3档-无规则] cmd=git status
  exit=3
  stdout=<rtk git status>
  stderr=<[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings>
```

其它同档样本（同一环境连续实测）：`ls -al`→`rtk ls -al`、`cat README.md`→`rtk read README.md`、`grep foo index.js`→`rtk grep foo index.js`、`cargo test`、`npm run build`、`git push`、`git log --oneline`、`curl https://example.com`，全部 exit 3。

### 1.6 pipeline deny/route（**不是** rewrite 的第四种子情形）

pipeline 规则能造出 deny，但只在 `rtk hook <agent>` 路径，且退出码恒 0。

```powershell
$P = Join-Path $env:TEMP "final\pipe"
New-Item -ItemType Directory -Force -Path "$P\.rtk" | Out-Null
@'
schema_version = 1
[pipeline]
name = "probe"
extends = "rtk:default"

[[hook.before_tool.shell]]
name = "block-rm"
when = { command_matches = "^rm" }
action = "deny"
message = "rm blocked by probe pipeline"
'@ | Set-Content "$P\.rtk\pipeline.toml"
Push-Location $P
rtk trust -y            # 必须：未 trust 的 .rtk/pipeline.toml 不会被加载
rtk pipeline show
rtk pipeline explain --command "rm -rf /tmp/x"
rtk rewrite "rm -rf /tmp/x"; "exit=$LASTEXITCODE"
'{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/x"}}' | rtk hook claude
rtk untrust             # 清理
Pop-Location
```

真实输出：

```
--- pipeline show ---
Pipeline: probe
Inherits: rtk:default
Rules (per position; first match wins, project before user before inherited):
  hook.before_tool.shell
    block-rm               [.rtk\pipeline.toml] when command_matches="^rm" -> action=deny
    rtk-rewrite            [rtk:default] when always -> action=rewrite
  ...
--- explain ---
hook.before_tool.shell: rule `block-rm` -> action deny
--- rewrite exit=1 stdoutLen=0 ---
--- hook claude exit=0 ---
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"rm blocked by probe pipeline"}}
```

补充事实（造 deny 时踩到的）：
- `.rtk/pipeline.toml` 需 `rtk trust` 才加载，且 trust 绑定 sha256：**文件任何改动都会失效**，报 `warning: TRUST .rtk\pipeline.toml changed since it was trusted — not loaded; review with rtk trust`。
- 合法 `action` 只有 `rewrite` / `deny` / `route`（`route` 还必须带 `task = "<name>"`，否则 `E014`）。写 `allow` / `block` / `ask_user` 报 `E005 unknown action`。
- 合法条件名：`command_matches`（正则）。`command_starts_with` / `command_regex` / `command_contains` / `command` 均不被识别（对应规则不匹配，`explain` 会显示落到继承的 `rtk-rewrite`）。
- `RTK_REWRITE_HOST` 取任何值（`claude` / `claude-code` / `cursor` / `openclaw` / `gemini` / `codex`）都不会让 rewrite 走 pipeline deny，实测均为 exit 1。

### 1.7 对当前插件实现的直接影响（契约后果，非代码评审）

`index.js:197` 目前是：

```js
resolve({ denied: true, message: out || String(stderr || '').trim() });
```

因为 exit 2 的 stdout 恒为空、stderr 只有 hook 噪声，`message` 实际会取到：

```
[rtk] No hook installed — run `rtk init -g` for automatic token savings
```

安全上无害（`denied` 判定不依赖 message，fail-closed 成立），但用户看到的拒绝理由会是这句噪声。契约层面正确的取法是：**deny 的 message 只应取 stdout，且应丢弃 `[rtk] ` 前缀行**；在 rtk 1.0.1 上等价于"永远没有 message"。这属于文案层面，不阻塞交付。

---

## 2. 每次 rewrite 调用都会打印的 hook 噪声

### 2.1 每档每次都打印（四档全部验证）

连续 3 次：

```powershell
Push-Location (Join-Path $env:TEMP "final\plain")
1..3 | ForEach-Object { rtk rewrite "git status" 1>$null 2>$env:TEMP\e; "run$_ stderrLen=$((Get-Item $env:TEMP\e).Length)" }
Pop-Location
```

```
run1 exit=3 stderrLen=79 stderr=[[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings]
run2 exit=3 stderrLen=79 stderr=[[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings]
run3 exit=3 stderrLen=79 stderr=[[rtk] /!\ No hook installed — run `rtk init -g` for automatic token savings]
```

exit 0 / 1 / 2 三种情形下 stderr 也是这一行 79 字节（见 §1.3、§1.2、§1.4 的实测记录）。它**没有任何节流**：`hook_warn_last` 这个字符串虽然存在于二进制里，但本轮 20+ 次调用每次都打印。

### 2.2 抑制方式：**没有 CLI 选项，只有配置键与环境变量**

- `rtk rewrite --help` 与 `rtk --help` 中**没有 `--quiet`**（`$help -match 'quiet'` → `False`）。
- 环境变量：`RTK_SUPPRESS_HOOK_WARNING`

```powershell
foreach($v in @('1','on','0','')) {
  if($v){ $env:RTK_SUPPRESS_HOOK_WARNING=$v } else { Remove-Item Env:\RTK_SUPPRESS_HOOK_WARNING -ErrorAction SilentlyContinue }
  rtk rewrite "git status" 1>$null 2>$env:TEMP\e
  "RTK_SUPPRESS_HOOK_WARNING='$v' exit=$LASTEXITCODE stderrLen=$((Get-Item $env:TEMP\e).Length)"
}
```

```
RTK_SUPPRESS_HOOK_WARNING='1'  exit=3 stderrLen=0
RTK_SUPPRESS_HOOK_WARNING='on' exit=3 stderrLen=0
RTK_SUPPRESS_HOOK_WARNING='0'  exit=3 stderrLen=79
RTK_SUPPRESS_HOOK_WARNING=''   exit=3 stderrLen=79
```

- 配置文件：`%APPDATA%\rtk\config.toml` 的 `[hooks] suppress_hook_warning = true` 同样完全抑制（实测 3 次调用 stderrLen 全为 0）。默认值是 `false`。
- 注意 rtk 在 Windows 上的配置目录是 **`C:\Users\ASUS\AppData\Roaming\rtk\`**，不是任务提示的 `~/.config/rtk/`（后者是 Linux 路径，二进制里的 `.rtk/filters.toml`、`~/.config/rtk/filters.toml` 字样属于跨平台文案）。

### 2.3 结论：插件不需要处理这个 stderr

- 插件用 `execFile` 只读 stdout 判断改写结果，stderr 不参与"是否改写"的判定，噪声无害。
- **唯一例外是 deny 的 message 取值**（§1.7）：exit 2 时 stdout 为空，若回落到 stderr 就会把噪声当理由。要么不改（安全但文案难看），要么在取 stderr 时过滤 `^\[rtk\] ` 行。
- 不需要设置 `RTK_SUPPRESS_HOOK_WARNING`：那会改变用户全局环境，且抑制后插件也拿不到任何有用信息。

---

## 3. 上游后续变更（develop，1.0.1 之后）

数据获取：`curl https://api.github.com/repos/rtk-ai/rtk/commits?per_page=40`（默认分支 `develop`，返回 40 条，最新 2026-10-19）。`default_branch=develop` 已由 `GET /repos/rtk-ai/rtk` 确认。

### 3.1 与 rewrite 契约直接相关的提交

| 提交 | 说明 | 是否会改四档 |
|---|---|---|
| `01738daf` | `fix(hook): verify integrity for rewritten RTK commands`（PR #4444 / issue #4433） | **不会**。`src/hooks/integrity.rs` 在 v1.0.1 与 develop 上**字节相同**（sha256 `FC2A18C0…`），`rewrite_cmd.rs` 亦相同 |
| `cd9dff3c` | `test(permissions): pin the load-failure warning and deny rules past a parse failure`（PR #4287） | **不会改渲染**，但改的是 verdict 判定源：`permissions.rs` 在 develop 上由 68129 字节增长到 85800 字节，属于 settings 读取健壮性重构 |
| `2fdcaa7d` | `fix(hooks): leave git unrewritten in Claude Code managed worktrees`（PR #3879 / issue #3864） | **不会**。新增的 `in_claude_worktree()` 与 `decide_for_agent_at(cmd, verdict, cwd)` 只挂在 agent 路径；`rtk rewrite` 的入口 `run()` 仍调用两参 `decide(cmd, verdict)` |
| `f16becac` | `chore/rewrite-exit-code-regression-test`（PR #4203） | 回归测试，非行为变更 |

### 3.2 判断依据：四档渲染代码在 develop 上未变

```
$ curl -s https://raw.githubusercontent.com/rtk-ai/rtk/v1.0.1/src/hooks/rewrite_cmd.rs -o 101.rs   # 12290 bytes
$ curl -s https://raw.githubusercontent.com/rtk-ai/rtk/develop/src/hooks/rewrite_cmd.rs -o dev.rs   # 12290 bytes
$ Compare-Object (Get-Content 101.rs) (Get-Content dev.rs)
无差异
```

逐个文件 sha256 对比（v1.0.1 vs develop）：

| 文件 | v1.0.1 | develop | 相同 |
|---|---|---|---|
| `src/hooks/rewrite_cmd.rs` | 12290 B | 12290 B | ✅ 无差异 |
| `src/hooks/integrity.rs` | 22307 B `FC2A18C0…` | 22307 B `FC2A18C0…` | ✅ |
| `src/hooks/hook_check.rs` | 13775 B `1EB63D1B…` | 13775 B `1EB63D1B…` | ✅ |
| `src/hooks/decision.rs` | 30059 B `467FA1D8…` | 34420 B `FE3363D7…` | ❌ 有变化 |
| `src/hooks/permissions.rs` | 68129 B `A6B5A7DE…` | 85800 B `A5538669…` | ❌ 有变化 |

`decision.rs` 的差异里，**v1.0.1 独有的可执行行只有一条**：

```
suppress_identity(cmd, decide(cmd, verdict))
```

即 `decide_for_agent` 内部从 `decide` 改成 `decide_for_agent_at`，`decide` 本身、`HookDecision` 枚举、`ApprovalOwner::apply` 均未变。其余差异是新增的 worktree 函数与测试。

由于 `rewrite_cmd.rs` 在 develop 上字节不变，它调用的 `check_command(cmd)` 与 `decide(cmd, verdict)` 的签名与四档 `match` 渲染都必然不变（否则 develop 不编译）。**结论：1.0.2 不会改变四档语义。**

### 3.3 1.0.0 的 BREAKING CHANGES 对本插件无影响（附依据）

CHANGELOG（tag `v1.0.1`，`## [1.0.0] … ### ⚠ BREAKING CHANGES`）原文：

> * **cli:** `rtk proxy <cmd>` is now `rtk bypass <cmd>` (the old name stays as an alias), `--ultra-compact` is removed, `rtk gain` excludes oversized outputs from its headline rate, and the default binary's licence changes (an Apache-2.0 edition, rtk-oss, ships alongside). See BREAKING_CHANGES.md.

逐条对照插件实际调用面：

| 变更 | 插件是否触及 | 依据 |
|---|---|---|
| `rtk proxy` → `rtk bypass`（旧名保留为 alias） | 否 | 插件只 spawn `rtk rewrite <cmd>`，`index.js:126` |
| `--ultra-compact` 移除 | 否 | 插件不传任何 rtk 全局选项；`rtk rewrite --help` 的 Options 只有 `--skip-env` 与 `-h` |
| `rtk gain` 统计口径 | 否 | 插件不调用 `gain` |
| 二进制许可证 | 否 | 运行时不涉及 |

（`BREAKING_CHANGES.md` 本身在 `v1.0.1` tag 上返回 404，仓库根只有 `CHANGELOG.md` 与 `docs/`；判断以上表 CHANGELOG 条目为准。）

### 3.4 一处需要记录的上游事实（不影响契约）

`develop` 分支的 `Cargo.toml` 写着 `version = "0.49.0"`，而 tag `v1.0.1` 的 `Cargo.toml` 是 `version = "1.0.1"`；`develop` 的 `CHANGELOG.md` 最新段也停在 `0.49.0`（2026-09-11）。tag 列表里 `v1.0.1`（`4ef8730c`）、`v1.0.0`（`01f819c4`）、`v0.52.0`、`v0.50.0` 均存在。含义：`develop` 的文件与发布 tag 不同步，看契约应以 **tag** 为准，而不是 develop 的版本字段。

（本机 `rtk --version` → `rtk 1.0.1`，与 tag 一致。）

---

## 4. DSH 侧：结果类型与"合成一个失败结果"

### 4.1 `ShellExecution` 完整字段（`node_modules/@deepseek-ai/dsh-shell/lib/types/types.d.ts`）

`ShellProcess`（同文件 186-224 行）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `'running' \| 'completed' \| 'killed'` | 状态只结算一次 |
| `exitCode` | `number \| null` | `null` = 被信号杀死 / 仍在跑 |
| `signal` | `NodeJS.Signals \| null` | |
| `done` | `Promise<void>` | 永不 reject |
| `sandbox?` | `ShellSandboxInfo` | 受限进程 settle 后盖章 |
| `readOutput()` | `() => ShellProcessRead` | 消费式，`{delta, lossy, stdoutSpillPath?, stderrSpillPath?}` |
| `observed` | `{stdout, stderr}: SubprocessOutputReader` | 非消费式偏移读取 |
| `kill()` | `() => boolean` | 已结束返回 false |

`ShellExecution extends ShellProcess` 只多一个方法：

| 字段 | 类型 | 说明 |
|---|---|---|
| `result()` | `() => Promise<ShellRunResult>` | 前台投影，按需创建并 memoize；只在基础设施失败（spawn 从未产生进程）时 reject |

`ShellRunResult`（150-170 行）：`exitCode: number|null`、`signal: NodeJS.Signals|null`、`timedOut: boolean`、`aborted: boolean`（与 `timedOut` 互斥，首因分类）、`timeoutMs: number`、`stdout: CollectedOutput`、`stderr: CollectedOutput`、`sandbox?: ShellSandboxInfo`。

`ShellSandboxInfo`（35-48 行）：`mode: SandboxMode`（`'read-only'|'workspace-write'|'danger-full-access'`）、`denied: boolean`（注释：**Whether the sandbox denied a file operation**）、`enforcement?: 'full'|'partial'`、`runnerFailed?: boolean`。

`CollectedOutput`（`dsh-subprocess`）：`{ text: string; truncated: boolean; spillPath?: string }`。
`SubprocessOutputReader.readFrom(fromByte) → SubprocessOutputRead = { text; nextOffset; lossy; spillPath? }`。

### 4.2 "不 spawn、直接合成失败结果"是否允许

**允许，且类型上没有任何障碍。** 依据：

1. `ShellExecution` / `ShellProcess` 是纯接口（`interface`），没有任何"必须由 subprocess provider 产出"的类型约束；`execute()` 的返回类型就是它。
2. `exitCode: number|null` 对非零值无取值限制，`status: 'completed'` 是合法枚举值。
3. `result()` 的契约要求"进程关闭时 settle"；合成 handle 的"进程从未存在"等价于已关闭，`Promise.resolve()` 满足。
4. `kill()` 的注释明确 "Returns false when it had already finished (no-op)" —— 合成 handle 返回 `false` 正是这个语义。
5. `sandbox` 字段在 `ShellRunResult` 上是可选的（"absent for an unsandboxed executor"），`ShellSandboxInfo` 的 `mode`/`denied` 必填、`enforcement`/`runnerFailed` 可选。

**约束（调用方预期）**：`exitCode === null` 被 `ShellRunResult` 定义为"preparation expired 或被信号杀死"，不是"未执行"；`sandbox.runnerFailed` 被定义为"沙箱 runner 在命令运行前失败"。**"被策略拒绝、从未执行"在 0.2.1-rc.2 里没有专用字段**，所以只能用"非零 exitCode + stderr 说明"表达，并在 stderr 里写明未执行。

### 4.3 `decorateResult` 与 `denied` 的既有用法（`dsh-pwsh-sandbox/lib/index.js`）

```js
// L211-219：不新建对象，只替换 handle 上的 result 方法并 memoize
static decorateResult(ex, map, mapError) {
  const base = ex.result.bind(ex);
  let decorated;
  ex.result = () => { decorated ??= base().then(map, mapError); return decorated; };
  return ex;
}

// L154-160：danger-full-access 路径
sandbox: { mode, denied: false }

// L182-188：未被 confine 的路径
sandbox: { mode, denied: false }

// L192-199：真受限路径
sandbox: { mode, denied: classifyDenial(result, denialSignatures), enforcement }

// L229-234：进程 settle 时给 handle 盖章
proc.sandbox = { mode: facts.mode, denied: !runnerFailed && matchesSignature(...), enforcement, ...(runnerFailed ? {runnerFailed} : {}) };
```

要点：
- `denied` **只由沙箱 denial 签名匹配产生**，与策略/规则拒绝无关 → 规则拒绝必须填 `denied: false`。
- 两条非受限路径都只用 `{ mode, denied: false }`、不带 `enforcement`。
- `decorateResult` 是给**已存在的 handle** 打补丁的私有工具；合成 handle 自己实现 `result()` 即可，不必也不应走它。
- 模块注释（L109-116）："the tool layer owns the escalation approval flow through `ctx.approval`; this executor reports the sandbox facts the tool renders" —— 工具层的升级流程由 `sandbox.denied` 触发，因此规则拒绝若误填 `true` 会引导用户走升级重试（重试仍会被拒）。

### 4.4 sandbox 包 0.2.1-rc.2 的 SHA256 对比证据

npm 元数据（`curl https://registry.npmjs.org/@deepseek-ai%2Fdsh-pwsh-sandbox`）：

```
dist-tags: {"latest":"0.0.1-rc.1","alpha":"0.2.1-alpha.5","next":"0.2.1-rc.2"}
next=0.2.1-rc.2
tarball=https://registry.npmjs.org/@deepseek-ai/dsh-pwsh-sandbox/-/dsh-pwsh-sandbox-0.2.1-rc.2.tgz
integrity=sha512-/nyuKupJho/gOnZpgLB1jIXRQ5imkXL50prDVjSUgXvbSQYcIC2k0t2v6oYpA5A9czt+bGJVqlDAxAEY0nf64g==
```

下载 tarball 解包后，与 `node_modules/@deepseek-ai/dsh-pwsh-sandbox` 逐文件比对：

| 文件 | npm 0.2.1-rc.2 | 本地 node_modules | 一致 |
|---|---|---|---|
| `LICENSE` | `EBB4F099…EA6BE` | `EBB4F099…EA6BE` | ✅ |
| `package.json` | `E955F7BE…987244` | `E955F7BE…987244` | ✅ |
| `lib/index.js` | `BED19D2C…15C6783` | `BED19D2C…15C6783` | ✅ |
| `lib/types/helpers.d.ts` | `7A8B1C62…203BB7` | `7A8B1C62…203BB7` | ✅ |
| `lib/types/index.d.ts` | `3FE07233…383E5D` | `3FE07233…383E5D` | ✅ |
| `locale/en.json` | `8A0FBFA0…13F7D6` | `8A0FBFA0…13F7D6` | ✅ |
| `locale/zh.json` | `F4BBBA76…6C5330` | `F4BBBA76…6C5330` | ✅ |
| `README.md` / `README.zh.md` / `README.i18n.yaml` | 见命令输出 | 同左 | ✅ |

10 个文件全部一致，本地副本未被修改，`SandboxPwshExecutor` 契约与 npm 发布版相同。

复现命令：

```powershell
curl.exe -sL "https://registry.npmjs.org/@deepseek-ai/dsh-pwsh-sandbox/-/dsh-pwsh-sandbox-0.2.1-rc.2.tgz" -o pkg.tgz
tar.exe -xzf pkg.tgz -C ex
Get-ChildItem ex -Recurse -File | % { "$($_.FullName)  $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
Get-ChildItem node_modules\@deepseek-ai\dsh-pwsh-sandbox -Recurse -File | % { "$($_.FullName)  $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
```

### 4.5 对已实现合成 handle 的核对（只记录契约结论）

`index.js` 的 `deniedExecution()` 返回对象逐字段符合 §4.1：`status:'completed'`、`exitCode:2`、`signal:null`、`done:Promise.resolve()`、`observed`（两个 reader 均返回 `{text,nextOffset,lossy}`）、`readOutput()`（`{delta,lossy}`）、`kill():false`、`result()`（7 个必填字段齐全，`sandbox` 条件附加）。`sandbox:{mode, denied:false}` 与 pwsh-sandbox 的两条非受限路径写法一致。

唯一与契约相关的瑕疵是 §1.7 的 deny message 取到 hook 噪声，不影响 fail-closed 正确性。

---

## 5. 实验现场清理（改了什么、怎么恢复）

为造出 allow / deny / pipeline deny，动过以下内容，**全部已恢复**：

| 位置 | 改动 | 现状 |
|---|---|---|
| `%APPDATA%\rtk\config.toml` | 临时写入 `[hooks] suppress_hook_warning = true` 验证抑制；曾建备份 `config.toml.bak-contract-analyst` | **已还原**：文件 52 字节，sha256 `C75ACFF1…E8633C`，与备份逐字节相同；备份文件已删除 |
| `%APPDATA%\rtk\` 目录 | 应只剩原有 2 个文件 | `config.toml`(52 B) + `filters.toml`(438 B) |
| rtk 信任库 | `rtk trust -y` 临时信任 `%TEMP%\rtk-rule-probe\.rtk\pipeline.toml` 与 `%TEMP%\final\pipe\.rtk\pipeline.toml` | **已撤销**：`rtk untrust` 两次，`rtk trust --list` → `No trusted filters.` |
| `~/.claude/settings.json` | **从未修改** | 2594 字节，mtime 2026-10-18 14:50:59（核验前时间） |
| 仓库文件 | **未改动** | 只新建了 `.planning/rtk-1.0-contract/contract.md` |

所有 allow/deny 规则都写在 `%TEMP%` 下的临时工作目录的 `.claude/` 里（利用 rtk 读取 cwd 及其祖先 `.claude` 的行为），没有碰用户全局 `~/.claude`。

复现本文件任一实验前，建议先在 `%TEMP%` 建空目录并 `Push-Location` 进去，避免被某个祖先目录的 `.claude` 规则干扰。

---

## 6. 未能复现 / 未验证的项（如实列出）

| 项 | 状态 | 原因 |
|---|---|---|
| exit 2 的"有输出"子情形（stdout 带 pipeline deny/route 消息） | **未能复现** | `rewrite_cmd.rs` 的 `Deny => exit(2)` 分支不打印任何内容；`decision.rs` 不含 pipeline 逻辑；pipeline deny 只在 `rtk hook <agent>` 的 JSON 协议里出现（exit 恒 0）。已用 `pipeline show` / `explain` / `hook claude` 三方交叉确认规则确实命中 |
| `action = "route"` 的实测 | **未验证** | `validate` 要求 `task = "<name>"`，需要配置 `[task.*]` + `[upstream.*]` 与模型 API key；本机无相关凭据，且 `rewrite` 路径根本不消费 pipeline（§1.6） |
| `~/.claude/settings.json`（用户级）单独贡献的 allow/deny | **未隔离验证** | 该文件没有 `permissions` 段；为避免污染用户全局配置，所有规则都写在临时目录的项目级 `.claude`。源码 `permissions.rs` 存在多路径 `get_settings_paths()`，但哪几个路径生效未逐项剥离验证 |
| DSH 工具层如何渲染 `sandbox.denied=false` + `exitCode=2` | **未能源码验证** | `E:\Tool\DSH\resources\app.asar` 是未解包的 182 MB 单文件（`app.asar\dsh\` 只是运行时说明里的逻辑路径，磁盘上不存在该目录）；结论只能依据 `dsh-pwsh-sandbox` 的模块注释（工具层升级流程由 `sandbox.denied` 触发） |
| `rtk rewrite` 是否读取 `settings.local.json` 与 `settings.json` 的优先级 | **部分验证** | 两者单独存在时都能生效；同时存在且冲突时的优先级**未测**（源码里 `settings.local.json` 字样存在，但未做冲突对照实验） |
