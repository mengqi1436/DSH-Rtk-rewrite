# impl-changes.md — index.js 改造说明（task-3）

执行者：impl-engineer
日期：2026-11-08
范围：`index.js`（唯一改动文件，101 增 14 删）。`cordis.patch.yml` / `package.json` 未动。

基线：`5de9afa chore(release): 1.1.8 [skip ci]`
本机实测环境：Windows 11 + MSYS bash，rtk 1.1.0（`C:/Users/Sjc/.local/bin/rtk.exe`），node v26.13.0，DSH 内核 0.2.1-rc.3 / peer 范围覆盖至 0.2.2-rc.1。

---

## 改动总览

| # | 位置 | 性质 | 依据 |
|---|---|---|---|
| 1 | 顶部设计注释（1-27） | 注释与行为对齐 | 行为已变，必须同步 |
| 2 | 顶端新增 `isRtkInvocation` 纯函数族（98-168） | 递归防护加固 + 抽纯函数 | `rtk-capabilities.md §6.1`；`registry.rs:836`、`:2008` |
| 3 | `rtkRewrite` 注释（170-186） | 契约注释重写 | `rewrite_cmd.rs:111-124`、`lib.rs:1069-1093` |
| 4 | `rtkRewrite` 退出码分支（199-216） | 显式化 exit 2 / 收紧 exit 3 | `rewrite_cmd.rs:122`；`lib.rs:1082-1084` |
| 5 | `execute()` 递归防护调用点（223-227） | 换用纯函数 | 同 #2 |
| 6 | `execute()` RTK_DISABLED 注释（223-225） | 概念纠偏 | `rtk-capabilities.md §4.1` |
| 7 | `execute()` 恒等比较注释（231-233） | 补充不变量说明 | `decision.rs:412-417` |

---

## #1 顶部设计注释：1-18 → 1-27

**改前**
```
 *  - Failure safety: any rewrite failure (rtk missing, exit 1 = no equivalent,
 *    timeout) runs the original command unrewritten. Execution is never
 *    blocked or denied by this plugin.
 */
```

**改后**（新增 4 条 + 补 exit 2）
```
 *  - Failure safety: any rewrite failure (rtk missing, exit 1 = no equivalent,
 *    exit 2 = deny, timeout) runs the original command unrewritten. Execution
 *    is never blocked or denied by this plugin.
 *  - `rtk rewrite` already decomposes compound commands and pipelines itself
 *    (`&&`, `||`, `;`, `|`) and returns the whole line rewritten, so this
 *    plugin hands the entire command over as one string — it never splits.
 *  - There is no command allowlist here: rtk routes every command family
 *    (cloud/dotnet/git/go/js/jvm/php/python/ruby/rust/scala/system/...) from
 *    its own rule registry, so new rtk families are covered for free.
 *  - `isRtkInvocation` keeps the plugin from rewriting an rtk call into
 *    another rtk call; it recognises bare/qualified/quoted/case-variant
 *    spellings in any segment of a compound command.
 */
```

**依据**：`registry.rs:749-771`（复合/管道逐段改写文档注释）、`registry.rs:1284-1397`（实现）、rtk 命令族目录 `src/cmds/{cloud,dotnet,git,go,js,jvm,php,python,ruby,rust,scala,system}`。
**影响**：仅注释。原文未提 exit 2、未说明「不拆分」与「无白名单」这两个已被实测确认的关键行为，属于必须补齐的一致性债。

---

## #2 新增 `isRtkInvocation` 纯函数族（index.js:98-168）

**改前**：无此函数。递归防护内联在 `execute()` 里，只有两个字面前缀：
```js
const trimmed = spec.command.trimStart();
if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) {
  return super.execute(spec);
}
```

**改后**：新增 5 段（导出 1 个纯函数 + 3 个内部辅助 + 2 个常量）：
```js
const RTK_EXE_NAMES = new Set(['rtk', 'rtk.exe']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function splitSegments(command) { /* 引号感知地按未引用的 ; & | 与 \n 切分 */ }
function firstWord(segment)     { /* 取段内首词，尊重成对包裹引号 */ }
function isRtkSegment(segment)  { /* 跳 env 赋值前缀 → 取首词 → 去引号 → 取 basename → 小写比对 */ }

export function isRtkInvocation(command) {
  const segments = splitSegments(String(command));
  return segments.length > 0 && segments.every(isRtkSegment);
}
```

**依据**
- 覆盖形态来源：`rtk-capabilities.md §6.1`（第 406-438 行）明确「必须加固」并列出五类形态。
- 上游自带的防护**窄于**本实现：`registry.rs:836`（`trimmed.startsWith("rtk ") || trimmed == "rtk"`）、`registry.rs:2008`（同上）、`rules.rs:1174`（`IGNORED_PREFIXES` 含 `"rtk "`）、`discover/mod.rs:295-297`——**全部大小写敏感、仅字面前缀、不认路径**。本函数刻意比上游宽，注释已写明这一点。
- **分段判定而非整串判定**：Lead 点名的关键反例 `ls -la && rtk git status` —— 实测 rtk 侧返回 `rtk ls -la && rtk git status`（首段有收益），若用「串里含 rtk 就整体跳过」会让首段永久失去收益。`every(isRtkSegment)` 保证只有「每段都是 rtk 调用」才整体跳过。

**影响**
- `rtk`、`rtk.exe`、`RTK`、`RTK.EXE`、`C:\...\rtk.exe`、`/c/.../rtk`、`./rtk`、`../bin/rtk.exe`、`"rtk"`、`'rtk'`、`"C:\Program Files\rtk\rtk.exe"`、`RTK_DISABLED=1 rtk ...`、多段全 rtk 复合命令 → 全部跳过 rewrite，省掉一次无意义 spawn。
- 混合命令（任一段首 token 非 rtk）→ 正常交给 rtk rewrite，首段照常获得收益。
- 不改变任何失败路径：即便判定为 false 交给 rtk，rtk 侧对不认识的形态一律 exit 1 → 原命令执行。
- 新导出 `isRtkInvocation`，供 test.js 独立单测（test.js 已实际使用，见 §自测）。

**极限说明**：函数不解析 PowerShell 特有语法（`& rtk`、`.\rtk.exe` 调用运算符、`Start-Process`）。实测这些形态在 rtk 侧均 exit 1，最终执行原命令，行为安全，故不为此增加复杂度（ponytail：不实现无证据需要的分支）。

---

## #3 `rtkRewrite` 契约注释重写（index.js:170-186）

**改前**
```
 * Observed exit-code behavior (rtk 0.50.0 on Windows, differs from --help
 * which documents "exits 0"): a supported command — including one already in
 * rtk form — exits 3 with the command on stdout; no equivalent exits 1 with
 * no output. ...
```

**改后**
```
 * Exit-code contract (`src/hooks/rewrite_cmd.rs:111-124`, mirrored in
 * `rtk rewrite --help`): 0 = rewritten, allow rules cover every command;
 * 3 = rewritten, host must confirm (the normal case — no rules configured);
 * 1 = nothing rewritten, run unchanged; 2 = a deny rule matched, nothing
 * printed. 0 and 3 both carry the line on stdout, and rtk does NOT suppress
 * identity rewrites, so the caller must compare against the original. ...
```

**依据**
- 历史注释说「--help 写 exit 0 但实测 exit 3、与文档不符」——**这是误读**。`--help` 是**条件句**：exit 0 仅在 Claude Code settings 的 allow 规则覆盖链上每条命令时成立（`rewrite_cmd.rs:112-116`）。
- 无规则机器上一切可改命令都是 exit 3，这是**刻意设计**：`rewrite_cmd.rs:242` 带注释 `// MUST be 3, not 0!`，`rewrite_cmd.rs:223-226` 解释了原因（若 Default 映射成 0 会绕过最小权限）。本机无 allow 规则，因此实测恒 3。
- 我另建临时 `.claude/settings.json` 分别构造 allow-all / deny 规则，实测拿到 **exit 0**（allow `Bash(*)`）与 **exit 2**（deny `Bash(rm -rf:*)`），确认四码契约成立。
- 恒等不抑制：`decision.rs:412-417`。

**影响**：仅注释，但纠正了一个会误导后续维护者的错误前提（「文档与实测不一致」实际是条件句未读懂）。

---

## #4 `rtkRewrite` 退出码分支显式化（index.js:199-216）

**改前**
```js
} else if (Number(err.code) === 1) {
  // rtk's documented "no equivalent" exit: silent pass-through.
} else if (out) {
  // e.g. exit 3: rtk printed the (possibly identity) rewritten form.
  resolve(out);
  return;
} else {
  warn(`rewrite exited ${err.code ?? 'unknown'} with no output; ...`);
}
```

**改后**
```js
} else if (Number(err.code) === 1) {
  // No rewrite: silent pass-through.
} else if (Number(err.code) === 2) {
  // Deny rule matched. Anything on stdout is a pipeline-rule message,
  // never a command line, so it must not be handed to the shell.
} else if (Number(err.code) === 3 && out) {
  // 3 = rewritten, approval deferred to the host. The normal case.
  resolve(out);
  return;
} else {
  warn(`rewrite exited ${err.code ?? 'unknown'} with no output; ...`);
}
```

**依据**
- **exit 2 静默化**：`rewrite_cmd.rs:122` 是全仓唯一的 `std::process::exit(2)`，此前无任何 `print!`，故实际恒无输出。改动前 exit 2 落到最后的 `else` 分支，打印「exit 2 with no output」——这是**误导性告警**（deny 是宿主的权限决策，不是插件错误）。`rtk-capabilities.md:459`、`:513` 判定为「必须改」。
- **`else if (out)` → `else if (Number(err.code) === 3 && out)`**：这是**真实隐患修复**，不是纯风格。`lib.rs:1082-1084` 的 `--help` 文本写明 exit 2 **可能带消息**（pipeline 规则 deny/路由），此时应「用该消息阻断命令」。改动前的 `else if (out)` 会把这条消息**当作改写后的命令交给 shell 执行**。虽然实测 rtk 1.1.0 的 exit 2 恒无输出（`rewrite_cmd.rs` 与 `--help` 在此处不一致，属上游文档债），但**契约允许有输出**，故必须按契约防御。
- 收紧到 exit 3 的副作用：未定义退出码（如 7）带 stdout 时不再采纳。这是**安全方向**的收紧——未知退出码的输出语义不明，不应当命令执行。test.js 的 A 组已把这条作为期望（`weird7` 场景），收紧后一致。

**影响**
- exit 2 → 静默透传原命令，无告警（原先有不准确告警）。
- exit 3 + stdout → 采纳改写（原行为不变）。
- exit 0 + stdout → 采纳改写（`!err` 分支，原行为不变）。
- exit 1 → 静默透传（原行为不变）。
- 未定义码 + stdout → 改为「告警 + 透传原命令」（原为采纳）。
- **核心不变量未动**：任何失败都执行原命令，绝不阻断，绝不降级沙箱。

---

## #5 `execute()` 递归防护调用点（index.js:226-227）

**改前**
```js
const trimmed = spec.command.trimStart();
if (trimmed.startsWith('rtk ') || trimmed.startsWith('rtk.exe ')) {
  return super.execute(spec);
}
```

**改后**
```js
if (isRtkInvocation(spec.command)) return super.execute(spec);
```

**依据**：同 #2。
**影响**：见 #2。局部变量 `trimmed` 随之删除（已无其他引用）。

---

## #6 `execute()` RTK_DISABLED 注释纠偏（index.js:223-225）

**改前**
```js
// rtk's own single-command opt-out: RTK_DISABLED=1 skips rewriting.
```

**改后**
```js
// This plugin's own global kill switch (rtk itself has no equivalent
// environment variable — only the `RTK_DISABLED=` command-text prefix).
```

**依据**：`rtk-capabilities.md §4.1`（第 329-336 行）。实测 `RTK_DISABLED=1 rtk rewrite 'git status'` → exit 3、照常改写，**进程环境变量对 rewrite 无效**；只有命令文本前缀 `RTK_DISABLED=1 git status` 才在 rtk 侧生效（`registry.rs:1898-1908`，实测 exit 1 + stderr 警告）。参考 hook 脚本 `hooks/claude/rtk-rewrite.sh` 全文也不检查该环境变量。

**影响**：仅注释。`if (process.env.RTK_DISABLED === '1')` 这一行**保留不动**——它是插件自加的合理安全阀（用户设了就完全不改写，行为可预期），只是原注释把它错记成上游语义。

---

## #7 `execute()` 恒等比较注释（index.js:231-233）

**改前**：`if (rewritten && rewritten !== spec.command) {` 无注释说明其不可替代性。

**改后**：逻辑一字未动，仅加 2 行注释
```js
// rtk does not suppress identity rewrites, so this comparison is the
// only thing standing between us and re-running the same command text.
if (rewritten && rewritten !== spec.command) {
```

**依据**：`decision.rs:412-417` —— `rtk rewrite` 把「已是 rtk 形态」当正常改写报出（exit 0 或 3，stdout 原样），**是否算「变了」由调用方判断**；抑制函数 `suppress_identity`（`decision.rs:418-428`）只给进程内 hook 用，不走 `rewrite` CLI。
**影响**：仅注释，但把「这一行绝对不能删」写进了代码。Lead 与 `rtk-capabilities.md:512` 均判定此为最后一道保险。

---

## 刻意「不改」的部分（说明理由）

| 事项 | 决定 | 理由 |
|---|---|---|
| 复合/管道命令拆分 | **不拆**，整体透给 rtk | 实测 rtk 自己逐段正确改写：`git status && git log` → `rtk git status && rtk git log`；`;`、`||`、`\|`、多行、引号内 `&&`、重定向 `2>&1` 全部正确（`registry.rs:1284-1397`）。插件拆分反而会破坏引号/heredoc 语义。 |
| 命令白名单 | **不引入**，且原代码本就没有 | 覆盖由 rtk registry 决定（96 条原生 RULES + 28 个 TOML filters）。实测 12 个命令族中 14/16 条命令被改写，js 族选错形态外全部覆盖（`npm run build`、`vitest run`、`npx tsc`、`eslint` 均有改写）。新增命令族自动受益。 |
| `RTK_REWRITE_HOST` 剔除 | **不做** | `rtk-capabilities.md §6.5` 建议 spawn 时 `env -u`，但属低危且非本任务诉求；引入 `env` 选项会改动 `execFile` 调用面，与「最小 diff」冲突。若后续确认有实际干扰再加。 |
| rtk 版本号语义化比较 | **不做** | `Cargo.toml=0.49.0`、本机 `1.1.0`、tag `dev-1.2.0-rc.620` 三轨不一致，版本比较不可靠；且实测本机 1.1.0 已具备上游 HEAD 全部 rewrite 契约，**无升级阻塞点**。 |
| `cordis.patch.yml` / `package.json` | **未动** | dsh 侧结论：子类化就是官方路径（`docs/subsystems/shell.md:249`），`{...spec, command}` 展开不丢 10 个 spec 字段，peer 范围已覆盖 0.2.1-rc.3 与 0.2.2-rc.1。 |
| `README.md` / `README_zh.md` | **未动** | 按硬约束归文档任务；且工作树中它们已由他人修改。 |

---

## 自测

### 1. 项目测试（test.js，由 test-engineer 重写，214 项）

```
$ cd /d/Code/DSH-Rtk-rewrite && node test.js
...
   ok   package.json 声明 dsh.bundle.patch
   ok   files 白名单包含 index.js 与 cordis.patch.yml
   ok   peerDependencies 声明 dsh-pwsh-sandbox
   ok   peer 范围覆盖 0.2.1-rc.3（includePrerelease）
   ok   peer 范围覆盖 0.2.2-rc.1（includePrerelease）
   ok   peer 范围默认语义会漏判预发布（说明 includePrerelease 必需）
   ok   cordis.patch.yml 禁用原 pwsh-sandbox 行

══════════════════════════════════════════════════════════════════
总计 214 项：通过 214 / 失败 0 / 与契约不一致 0

RESULT: ALL PASS
```

**注**：首次跑出 1 项失败 —— `[A. rewrite 退出码契约] exit 7 + 输出（未定义码）→ 原样执行 — 实际执行: "rtk weird"`。这是 #4 收紧前 `else if (out)` 兜底的后果，按安全方向收紧为 `Number(err.code) === 3 && out` 后一致。**test.js 本身无需修改**。

### 2. 递归防护纯函数矩阵（自建，29 例，全过）

```
$ node .tmp-probe/guard-check.mjs
ok   isRtkInvocation("rtk git status") = true
ok   isRtkInvocation("rtk") = true
ok   isRtkInvocation("rtk.exe git status") = true
ok   isRtkInvocation("RTK git status") = true
ok   isRtkInvocation("RTK.EXE git status") = true
ok   isRtkInvocation("C:\\Users\\Sjc\\.local\\bin\\rtk.exe git status") = true
ok   isRtkInvocation("/c/Users/Sjc/.local/bin/rtk git status") = true
ok   isRtkInvocation("./rtk git status") = true
ok   isRtkInvocation("../bin/rtk.exe git status") = true
ok   isRtkInvocation("\"rtk\" git status") = true
ok   isRtkInvocation("'rtk' git status") = true
ok   isRtkInvocation("\"C:\\Program Files\\rtk\\rtk.exe\" git status") = true
ok   isRtkInvocation("RTK_DISABLED=1 rtk git status") = true
ok   isRtkInvocation("FOO=1 BAR=2 rtk git status") = true
ok   isRtkInvocation("rtk git status && rtk git log") = true
ok   isRtkInvocation("rtk git status; rtk git log") = true
ok   isRtkInvocation("rtk git status\nrtk git log") = true
ok   isRtkInvocation("ls -la && rtk git status") = false
ok   isRtkInvocation("git status && rtk git log") = false
ok   isRtkInvocation("git status; rtk git log") = false
ok   isRtkInvocation("git status | rtk something") = false
ok   isRtkInvocation("git status") = false
ok   isRtkInvocation("rtkx git status") = false
ok   isRtkInvocation("myrtk git status") = false
ok   isRtkInvocation("\"ls\" && rtk git status") = false
ok   isRtkInvocation("") = false
ok   isRtkInvocation("   ") = false
ok   isRtkInvocation("echo \"rtk git status\"") = false
ok   isRtkInvocation("rtk git status | head") = false   // 实测 rtk 侧恒 exit 1，交给 rtk 也不会变
ALL PASS
```

### 3. 端到端决策矩阵（自建，18 例，全过；真实 rtk 1.1.0）

```
$ node .tmp-probe/e2e-check.mjs
ok   [rewritten] "ls -la && rtk git status" -> "rtk ls -la && rtk git status"    ★ Lead 点名反例
ok   [rewritten] "git status && rtk git log" -> "rtk git status && rtk git log"
ok   [rewritten] "git status; rtk git log" -> "rtk git status; rtk git log"
ok   [guard] "rtk git status" -> "rtk git status"
ok   [guard] "rtk.exe git status" -> "rtk.exe git status"
ok   [guard] "RTK git status" -> "RTK git status"
ok   [guard] "C:\\Users\\Sjc\\.local\\bin\\rtk.exe git status" -> 原样
ok   [guard] "RTK_DISABLED=1 rtk git status" -> 原样
ok   [guard] "rtk git status && rtk git log" -> 原样
ok   [rewritten] "git status && git log" -> "rtk git status && rtk git log"
ok   [rewritten] "git status; git log" -> "rtk git status; rtk git log"
ok   [rewritten] "cargo test || echo fail" -> "rtk cargo test || echo fail"
ok   [rewritten] "git status | head -5" -> "rtk git status | head -5"
ok   [rewritten] "git status 2>&1" -> "rtk git status 2>&1"
ok   [passthrough] "echo hi" -> "echo hi"
ok   [passthrough] "Get-ChildItem" -> "Get-ChildItem"
ok   [passthrough] "for i in 1 2; do git status; done" -> 原样
ok   RTK_DISABLED=1 全局跳过 -> "git status"
ALL PASS
```

### 4. 四种退出码分支（自建，用真实 rtk + 临时 `.claude/settings.json` 构造）

```
$ node .tmp-probe/exitcode-check.mjs
ok   exit0 allow-all  → 采纳: got="rtk git status" want="rtk git status" (新增告警 0 条)
ok   exit1 无等价    → null (新增告警 0 条)
ok   exit1 已忽略    → null (新增告警 0 条)
ok   exit2 deny      → null(静默) (新增告警 0 条)
ok   exit3 默认      → 采纳: got="rtk git status"
ok   exit3 已 rtk 恒等 → 采纳但等于原串 (新增告警 0 条)
ok   恒等抑制：rewritten("rtk git status") === command，不会重跑
ALL PASS
```

### 5. 命令族透明覆盖（自建，真实 rtk）

```
$ node .tmp-probe/families-check.mjs
covered   [git] "git status" -> "rtk git status"
covered   [rust] "cargo test" -> "rtk cargo test"
covered   [python] "python3 -m pytest" -> "rtk pytest"
covered   [go] "go test ./..." -> "rtk go test ./..."
covered   [jvm] "mvn -q package" -> "rtk mvn -q package"
covered   [jvm] "gradle build" -> "rtk gradlew build"
covered   [dotnet] "dotnet build" -> "rtk dotnet build"
covered   [php] "php vendor/bin/phpunit" -> "rtk phpunit"
covered   [ruby] "bundle exec rspec" -> "rtk rspec"
covered   [scala] "sbt compile" -> "rtk sbt compile"
covered   [cloud] "aws s3 ls" -> "rtk aws s3 ls"
covered   [system] "ls -la" -> "rtk ls -la"
covered   [system] "docker ps" -> "rtk docker ps"
covered   [system] "gh pr list" -> "rtk gh pr list"
覆盖 14 / 16
未覆盖（透传原命令，安全）：js:npm install, js:pnpm test
```

js 族「未覆盖」是我选的命令形态问题，非覆盖缺口。补测：

```
[npm run build]   exit=3 out=[rtk npm run build]
[pnpm run build]  exit=3 out=[rtk pnpm run build]
[vitest run]      exit=3 out=[rtk vitest]
[npx tsc --noEmit] exit=3 out=[rtk tsc --noEmit]
[eslint src]      exit=3 out=[rtk lint src]
[prettier --check .] exit=3 out=[rtk prettier --check .]
```

**结论**：js 族同样被覆盖，13 个命令族全部通过插件透明受益，**无需任何白名单**。

---

## 需要 Lead 协调的事项

**无阻塞冲突。** 两点备查：

1. **test.js 无需我改动** —— test-engineer 重写的 214 项已全部对齐本次实现（含它自己发现的 `weird7` 场景）。我只改了 index.js。
2. **工作树中 `README.md` / `README_zh.md` 已被他人修改**（`git status` 显示 `M`），我未触碰。文档任务需注意：`index.js` 顶部注释现已明确「RTK_DISABLED 是插件开关、退出码 0 是 allow 覆盖的条件态、无白名单、不拆分复合命令」，README 措辞应与之一致。
3. **`RTK_REWRITE_HOST` 剔除与 `env -u`** 按 ponytail 未做（见「刻意不改」表），若 review 判定必须做，成本是一行 `execFile` 选项，可随时补。

---

## 附：验证脚本位置

自建验证脚本在 `.tmp-probe/`（未纳入 git，`?? .tmp-probe/`）：
- `guard-check.mjs` —— 递归防护 29 例矩阵
- `e2e-check.mjs` —— 端到端决策 18 例
- `exitcode-check.mjs` —— 四码分支（真实 rtk + 临时 settings）
- `families-check.mjs` —— 命令族覆盖

这些是取证用的临时脚本，非交付物；test.js 已覆盖同类断言。

---

# 审查修复（task-7）

来源：`review-report.md` 的 1 条阻塞 + 1 条必修 + 1 条注释夸大，Lead 已复核认定成立。
本轮只改 `index.js`（net +14/−11 相对上一轮），`test.js` / `README` 未触碰。
修复后 `node test.js`：**260 项全部通过**（test-engineer 已并行补入 3 条新用例）。

---

## P0-1（阻塞）：try 范围过宽 → 沙箱异常被吞 + 命令执行两次

### 改前（index.js:229-242 旧编号）

```js
try {
  const rewritten = await rtkRewrite(spec.command);
  if (rewritten && rewritten !== spec.command) {
    log(...);
    return await super.execute({ ...spec, command: rewritten });   // ← 在 try 内
  }
} catch (err) {
  warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);
}
return super.execute(spec);                                        // ← 第二次提交
```

### 改后（index.js:236-256 新编号）

```js
let rewritten = null;
try {
  rewritten = await rtkRewrite(spec.command);                      // 只有改写 fail-open
} catch (err) {
  warn(`rewrite failed (${err?.message ?? err}); running command unrewritten`);
}
// rtk does not suppress identity rewrites, so this comparison is the only
// thing standing between us and re-running the same command text.
if (rewritten && rewritten !== spec.command) {
  log(JSON.stringify(spec.command), '->', JSON.stringify(rewritten));
  return super.execute({ ...spec, command: rewritten });
}
return super.execute(spec);
```

### 依据

- `pwsh-sandbox/src/index.ts:96` 的 `execute()` 会在三处抛异常：`:129` `throw new SandboxUnavailableError(...)`（runner 链断）、`:134` `spec.signal.throwIfAborted()`（调用已取消）、`:135` runner spawn 失败重抛。三处都是**执行侧**失败，与改写无关。
- 改前这三次异常全部被插件 catch 吞掉，后果双向：
  1. **用户已取消的命令照跑** —— 取消信号变成一条 warn。
  2. **沙箱根本没建立的失败被降级成 warn** —— 直接违反上一轮报告里我自己写的核心不变量「绝不降级沙箱」。
  3. **同一命令提交执行器两次** —— catch 后落到 `return super.execute(spec)`。对写操作（`git push`）意味着执行两遍。

根因是概念混淆：把「失败安全」（改写失败该 fail-open）错用到了「执行安全」（执行失败必须原样上抛）。

### 验证（`probe-abort.mjs`，改前 / 改后对照）

改前：
```
已取消 + abort-always    调用序列=["rtk git status","git status"]    抛出=none
沙箱 runner 失败         调用序列=["rtk git status","git status"]    抛出=none
```
改后：
```
## 1. 取消（signal.aborted）场景
[rtk-rewrite] "git status" -> "rtk git status"
  已取消 + abort-always                   调用序列=["rtk git status"]   抛出=AbortError
[rtk-rewrite] "git status" -> "rtk git status"
  已取消 + 正常                            调用序列=["rtk git status"]   抛出=none

## 2. 沙箱 unavailable 场景
[rtk-rewrite] "git status" -> "rtk git status"
  沙箱 runner 失败                         调用序列=["rtk git status"]   抛出=SandboxUnavailableError

## 3. 对照：guard 命中（rtk 调用）不走 catch
  命令本身是 rtk                            调用序列=["rtk git status"]   抛出=SandboxUnavailableError
```

三条关键断言全部达成：**调用序列长度恒为 1**、取消抛 `AbortError`、沙箱失败抛 `SandboxUnavailableError`。

### 影响

- 改写失败：仍 fail-open，行为不变。
- 执行失败：改为原样上抛，不再被吞。
- 命令执行次数：从「可能 2 次」变为「恒 1 次」。
- 沙箱语义：恢复为「绝不降级」。

---

## P1-1（必修）：`-h` / `--help` 的帮助文本被当命令执行

### 改前（`rtkRewrite` 内，index.js:187-190 旧编号）

```js
execFile(RTK_BIN, ['rewrite', command], { ... })
```

### 改后（index.js:196-201 新编号）

```js
execFile(
  RTK_BIN,
  // `--` keeps clap from eating a leading-dash command as its own flag:
  // `rtk rewrite -h` would print help on stdout and exit 0, and that text
  // would then be handed to the shell as if it were a rewritten command.
  command.startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command],
  { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
```

### 依据

`rtk rewrite` 的位置参数声明为 `trailing_var_arg = true, allow_hyphen_values = true`（`lib.rs:1099`）。但 `allow_hyphen_values` 只影响**已进入位置参数之后**的解析；当命令本身就是第一个 argv 且以 `-` 开头时，clap 仍先做自己的 flag 匹配：`-h` / `--help` 命中 help、`-v` / `--version` 命中 version，打印到 **stdout** 并 **exit 0**。插件的 `if (!err) resolve(out || null)` 于是把这段帮助文本当成「改写结果」交给 shell 执行。

加 `--` 后 clap 停止解析后续 flag，命令原样进入位置参数。这与 `decision.rs:73-81` 的设计意图一致 —— 该处明确写了「`Commands::Rewrite` 的 positional 是 `trailing_var_arg = true, allow_hyphen_values = true`，所以不认识某 flag 的 rtk 会把它折叠进被判定的命令文本」，`--` 正是消除这个歧义的标准手段。

### 验证（`probe-dash.mjs`，改前 / 改后对照）

改前（`-h` 与 `--help` 把 help 文本当命令执行）：
```
"-h"      最终执行="Rewrite a raw command to its RTK equivalent (single source of truth fo"  << 把 HELP 文本当成命令执行了！
"--help"  最终执行="Rewrite a raw command to its RTK equivalent (single source of truth fo"  << 把 HELP 文本当成命令执行了！
```

改后（全部原样执行，无 help 文本泄漏）：
```
  "-h"           最终执行="-h"
  "--help"       最终执行="--help"
  "-v"           最终执行="-v"
  "--version"    最终执行="--version"
  "--"           最终执行="--"
  "-x ls"        最终执行="-x ls"
  "pwsh -h"      最终执行="pwsh -h"
  "git -h"       最终执行="git -h"
```

### 影响

- 以 `-` 开头的命令（`-h`/`--help`/`-v`/`--version`/`--`/`-x ls`）不再把 help 文本当命令；rtk 侧一律 exit 1 → 原命令执行。
- 不以 `-` 开头的命令：argv 与改前**完全一致**（`['rewrite', command]`），零行为变化。
- 审查员另测得唯一差异：`--skip-env=1 git status` 从 exit 2 变 exit 1 —— 两条都是安全透传，无功能影响。

---

## P2-3（注释）：`isRtkInvocation` 的能力描述夸大

### 改前（index.js:153-164 旧编号，函数 JSDoc）

```
 * Note rtk's own guard is case-sensitive and literal-only
 * (`registry.rs:836`, `:2008`), so this is deliberately broader than upstream.
 */

顶部设计注释亦写：
 *  - `isRtkInvocation` keeps the plugin from rewriting an rtk call into
 *    another rtk call; it recognises bare/qualified/quoted/case-variant
 *    spellings in any segment of a compound command.
```

「in any segment of a compound command」夸大了 —— 实测有 6 处漏判。

### 改后（函数 JSDoc）

```
 * This is a fast path, not a complete recogniser. It does not read through a
 * wrapper (`sudo rtk ...`, `powershell -c "rtk ..."`), a quoted env value
 * (`FOO="a b" rtk ...`), an assignment whose name collides (`rtk=1 ls`), a
 * CRLF line break, or a `#` comment. Those all return false and simply get
 * rewritten once more, which is safe because rtk exits 1 on a first word it
 * does not recognise — so safety here leans on upstream's tolerance, and it
 * needs revisiting if rtk ever starts rewriting through `sudo`/`powershell`.
 * rtk's own guard is case-sensitive and literal-only (`registry.rs:836`,
 * `:2008`), so this is still deliberately broader than upstream.
```

顶部设计注释同步改为：
```
 *  - `isRtkInvocation` is a best-effort fast path that skips rewriting when
 *    every segment already calls rtk; it does not read through wrappers or
 *    quoted env values, and the misses are safe (see its own comment).
```

另外顶部「Failure safety」条目补了一句限定，把 P0-1 的边界写清：
```
 *    is never blocked or denied by this plugin. That tolerance covers the
 *    rewrite only — a failure thrown by super.execute() is the execution's
 *    own and propagates untouched (see execute()).
```

### 验证（6 处漏判逐一核实，全部返回 false = 安全）

```
$ node .tmp-probe/p23-check.mjs
ok   isRtkInvocation("sudo rtk git status") = false            (wrapper sudo)
ok   isRtkInvocation("FOO=\"a b\" rtk git status") = false      (quoted env value)
ok   isRtkInvocation("powershell -c \"rtk git status\"") = false (powershell -c)
ok   isRtkInvocation("rtk=1 ls") = false                       (assignment name collision)
ok   isRtkInvocation("rtk\r\ngit status") = false              (CRLF)
ok   isRtkInvocation("rtk git status # ; ls") = false          (comment)
与审查报告一致：6 处均为漏判（返回 false，安全多跑一次）
```

漏判的代价只是多一次 spawn，结果正确；安全性部分依赖 rtk 对不认识的首词一律 exit 1（`rewrite_cmd.rs:123` → `Defer`）。这一点已写进注释，并注明若 rtk 未来把 `sudo`/`powershell` 纳入改写规则需重新评估。

### 影响

仅注释。行为零变化（6 处仍返回 false，与改前一致）。

---

## 复验汇总

```
$ node test.js
══════════════════════════════════════════════════════════════════
总计 260 项：通过 260 / 失败 0 / 与契约不一致 0

RESULT: ALL PASS
```

| 验证项 | 手段 | 结果 |
|---|---|---|
| P0-1 调用序列恒为 1 | `probe-abort.mjs` | ✅ 三条场景全部 `["rtk git status"]` |
| P0-1 取消不被吞 | `probe-abort.mjs` | ✅ 抛 `AbortError` |
| P0-1 沙箱失败不被吞 | `probe-abort.mjs` | ✅ 抛 `SandboxUnavailableError` |
| P1-1 help 文本不被执行 | `probe-dash.mjs` | ✅ `-h`/`--help` 最终执行 = 原命令 |
| P2-3 注释与实测一致 | `.tmp-probe/p23-check.mjs` | ✅ 6 处漏判全部核实 |
| 全量回归 | `node test.js` | ✅ 260/260 |

本轮未触碰 `test.js`、`README.md`、`README_zh.md`、`cordis.patch.yml`、`package.json`，与 test-engineer / docs-writer 的边界保持清晰。
