# rtk 上游命令能力与 rewrite 契约调研

- 调研对象：`rtk-ai/rtk`，本地克隆 `/d/Code/_upstream/rtk`（**未修改**）
- 分支 / HEAD：`develop` / `bd7f87e`（Merge PR #5013），tag `dev-1.2.0-rc.620` 即打在 HEAD 上
- 本机安装版：`rtk 1.1.0`（`rtk --version` 实测，Windows / MSYS bash）
- 上游 `Cargo.toml:25` 声明 `version = "0.49.0"`（`.release-please-manifest.json` 同为 `0.49.0`）——**版本号体系不连续**，见 §5.1
- 撰写日期：2026-11-08
- 取证方式：读上游源码（每条标 `文件:行号`）+ 本机 rtk 1.1.0 实测（标「实测」）。**推测**一律显式标注。

> 筛选标准：本文档服务于「DSH 插件在每条 shell 命令执行前调 `rtk rewrite` 」这一场景。不是 rtk 功能大全；与插件无关的过滤细节从略。

---

## ① rewrite 契约表

### 1.1 调用形态

| 项 | 结论 | 依据 |
|---|---|---|
| 子命令名 | `rewrite` | `src/lib.rs:1096`、本机 `rtk --help` |
| 参数 | `args: Vec<String>`，`trailing_var_arg = true, allow_hyphen_values = true` | `src/lib.rs:1097-1100` |
| 参数合并 | 多个 argv 用**单空格 join** 拼成一条命令字符串 | `src/lib.rs:3739` `let cmd = args.join(" ")` |
| 等价性 | `rtk rewrite ls -al` ≡ `rtk rewrite "ls -al"`（实测两者都得 `rtk ls -la` 系同等价形态） | `src/lib.rs:1098` 文档 + 实测 |
| 无 `--shell` flag | **不存在**。`--shell` 是 `err` / `test` / `summary` / `run` 的选项，不是 `rewrite` 的 | `src/lib.rs:334`、`344`、`430`、`805-811`；`rewrite --help` 实测只有 `--skip-env` |
| 无 stdin 交互 | `run(cmd)` 只处理 argv 传入的命令文本，不读 stdin | `src/hooks/rewrite_cmd.rs:91` |
| `--skip-env` | `global` flag，设 `SKIP_ENV_VALIDATION=1` 给子进程；对 `rewrite` 的判断逻辑无影响 | `src/lib.rs:101-103`、`src/lib.rs:3446` |

**插件影响**：插件用 `execFile(RTK_BIN, ['rewrite', command])` 直接把整条命令作为一个 argv 传，与上游设计一致，是正确的。

### 1.2 退出码语义（源码权威版）

`rewrite` 的实现只有 125 行有效代码，是把 `decision::decide` 的判决渲染成退出码。

| 退出码 | stdout | stderr | 含义 | 依据 |
|---|---|---|---|---|
| **0** | 改写后的命令（无换行） | 空 | `AllowRewrite`：改写成立，且 allow 规则覆盖链上**每一条**命令 → 宿主可自动放行 | `src/hooks/rewrite_cmd.rs:112-116` |
| **1** | 空 | 一般空 | `Defer`：不改写。原因包括：无 rtk 等价、无可改段、命令被 `exclude_commands` 排除、含不可证构造（`$(...)`、文件重定向、heredoc）、shell wrapper 脚本内命中 deny | `src/hooks/rewrite_cmd.rs:123`、`src/hooks/decision.rs:289-291`、`298` |
| **2** | 空 | 空 | `Deny`：deny 规则命中。**先于一切判断** | `src/hooks/rewrite_cmd.rs:122`、`src/hooks/decision.rs:253-255` |
| **3** | 改写后的命令（无换行） | 空 | `AskRewrite`：改写成立，但命中 ask 规则，**或 allow 规则未能覆盖全链（含"根本没有规则"）** → 宿主自己弹权限确认 | `src/hooks/rewrite_cmd.rs:117-121` |

判决优先级（`PermissionVerdict`）：`Deny > Defer > Ask > Allow > Default(ask)`（`src/hooks/permissions.rs:37`、`343-351`）。

### 1.3 「--help 写 exits 0，实测 exit 3」的根因 ← 本任务最关键发现

**结论：两个数字都对，但描述的是不同规则状态，历史笔记把两者当成矛盾是误读。**

证据链：

1. `rtk rewrite "git status"` → 实测 `exit=3`，stdout=`rtk git status`。
2. `check_command()` 加载的是 **Claude Code 的 `~/.claude/settings*.json` 权限规则**，不是 rtk 自己的配置：
   - `src/hooks/rewrite_cmd.rs:103` `let verdict = permissions::check_command(cmd);`
   - `src/hooks/permissions.rs:40-42` `check_command` → `check_command_for(cmd, Host::Claude)`
   - `src/hooks/decision.rs:92-96` 注释明确：`rtk rewrite` 对**所有** delegate 只有一个规则来源 —— `~/.claude`
3. 本机没有（或没有覆盖该命令的）allow 规则 → `verdict = PermissionVerdict::Default`。
4. `Default` 在**源码里被硬性映射到 exit 3**，且这段逻辑带一条安全注释与专门的回归测试：
   - `src/hooks/rewrite_cmd.rs:242` `PermissionVerdict::Default => 3, // MUST be 3, not 0!`
   - `src/hooks/rewrite_cmd.rs:223-226`：若把 `Default` 映到 0，任何没有权限规则的可改命令都会被自动放行 —— 这是 issue #1155 的漏洞
   - `src/hooks/rewrite_cmd.rs:292-305` `test_no_auto_allow_bypass_for_unrecognized_commands` 专门锁住这一行为
5. exit 0 只在**用户显式写了 allow 规则且覆盖全链**时出现：
   - `src/hooks/permissions.rs:344-348`：`Allow` 需同时满足「至少有一段」「所有段都匹配 allow」「allow 规则非空」
   - `src/hooks/rewrite_cmd.rs:269-274` 测试用 `allow = ["git *"]` 才得到 0

**所以**：`--help`（`src/lib.rs:1069-1093`）写的「0 - rewrite printed, allow rules cover every command」是**条件句**，不是「有改写就 exit 0」。默认无规则机器上，一切可改命令都是 **exit 3 + stdout**。

> **插件必须按 `exit 3 也是成功的改写` 处理。** 现行 `index.js:120-125` 已把「非 1、非 ENOENT/超时、且有输出」当作改写成功，方向正确；但这段判断散落在 `else if` 链里，语义脆弱（详见 §6 第 1 条）。

### 1.4 stdout / stderr 分工

| 通道 | 内容 | 依据 |
|---|---|---|
| stdout | 改写后的命令字符串，`print!` 输出，**无尾换行** | `src/hooks/rewrite_cmd.rs:113`、`118` |
| stderr | 正常路径不写。唯一例外：命令文本里带 `RTK_DISABLED=` 前缀时打印一行警告，然后返回 `None`（exit 1） | `src/discover/registry.rs:1902-1908`；实测 stderr = `[rtk] RTK_DISABLED=1 detected — skipping filter for this command. ...` |
| 参考实现在做什么 | 官方 hook 脚本把 stderr 整个丢弃：`2>/dev/null` | `hooks/claude/rtk-rewrite.sh:59` |

**插件影响**：不要用 stderr 判定成败；stderr 只做调试透传即可。现行 `index.js` 忽略 stderr，符合参考实现。

### 1.5 幂等 / 恒等改写

| 形态 | 实测结果 | 依据 |
|---|---|---|
| `rtk rewrite "rtk git status"` | exit 3，stdout = `rtk git status`（**原样返回，不改）** | 实测；`src/discover/registry.rs:2008-2010`、`836-838` |
| `rtk rewrite "rtk"` | exit 3，stdout = `rtk` | 实测；`src/discover/registry.rs:836` |
| `rtk rewrite "rtk rtk git status"` | exit 3，stdout = `rtk rtk git status`（不收敛，原样返回） | 实测 |
| `rtk rewrite "rtk gain"` | exit 3，stdout = `rtk gain` | 实测 |

**关键**：`rtk rewrite` **自己不做恒等抑制**。`decision.rs:412-417` 注释写得很明确：`rtk rewrite` 把「已经是 rtk 形态」当作正常改写报出（exit 0 或 3，stdout 原样）；**是否算"变了"由调用方判断**。抑制函数 `suppress_identity`（`src/hooks/decision.rs:418-428`）只给进程内的 hook 用，不走 `rewrite` CLI。

**插件影响**：插件必须自己比较 `rewritten !== command`（`index.js:146` 已做，正确）。同时**递归防护不能砍掉**——`rtk rewrite "rtk git status"` 会原样回吐，若插件不判前缀也不比相等，最坏情况是拿同样的命令再走一遍（多一次 spawn），不会死循环，但会浪费且日志噪声。

### 1.6 管道 / 复合命令 / 多行

`rewrite_command` 支持复合与管道，逐段独立改写（`src/discover/registry.rs:749-771` 文档、`1284-1397` 实现）。

| 输入 | 实测 exit / stdout | 依据 |
|---|---|---|
| `git status && git log` | 3 / `rtk git status && rtk git log` | 实测；`registry.rs:1310-1322`（`&&`/`\|\|`/`;` 各自改写） |
| `git status; ls -la` | 3 / `rtk git status; rtk ls -la` | 实测 |
| `git status \| head -5` | 3 / `rtk git status \| head -5` | 实测；管道只改 producer（head 是 final） |
| `cat a.txt \| grep foo` | 3 / `cat a.txt \| rtk grep foo` | 实测；grep 可作 final stage（`rules.rs:138` `PipelineSafety::Both`） |
| `cargo test 2>&1 \| tail -20` | 3 / `rtk cargo test 2>\&1 \| tail -20` | 实测 |
| `ls \| wc -l` | **1 / 空** | 实测；`wc` 的 pipeline 安全性未放行 → 整条管道不动（`registry.rs:2073-2085`） |
| `git log \| wc -l` | **1 / 空** | 实测 |
| 多行（`git status\ngit log`） | 3 / `rtk git status\nrtk git log` | 实测；走 `rewrite_multiline_block`（`registry.rs:815-817`、`980`） |
| `git commit -m "fix && update"` | 3 / `rtk git commit -m "fix && update"`（**引号内的 `&&` 未被误切**） | 实测；词法分析器 `lexer.rs` 处理引号 |
| `GIT_PAGER=cat git status` | 3 / `GIT_PAGER=cat rtk git status`（env 前缀保留） | 实测；`registry.rs:1898-1918` |
| `env git status` | 3 / `env rtk git status` | 实测 |

**插件影响**：**不需要拆分复合命令**。整条命令传给 `rtk rewrite` 即可，rtk 自己会逐段改写并原样保留分隔符与引号。这也意味着插件不能假设「返回值与输入只差一个 `rtk ` 前缀」。

### 1.7 明确拒绝改写的构造

| 构造 | 实测 | 依据 |
|---|---|---|
| 命令替换 `echo $(git status)` | exit 1，空 | 实测；`decision.rs:289-291` `contains_unattestable_construct` |
| 文件重定向 `git status > out.txt` | exit 1，空 | 实测；同上 + `registry.rs:694` |
| heredoc `cat <<EOF...` | exit 1，空 | 实测；`registry.rs:811-813` `has_heredoc` |
| `$((` 算术展开 | exit 1，空 | `registry.rs:794-799`、`811-813` |
| `RTK_DISABLED=1 git status` | exit 1，空，**stderr 一行警告** | 实测；`registry.rs:1898-1908` |
| 空命令 `""` | exit 1，空 | 实测；`registry.rs:807-809` |
| `cat -v file`（非 `-n` 的 cat 旗标） | exit 1，空 | 实测；`registry.rs:2027-2032` |
| `echo hi` / `cd /tmp` | exit 1，空 | 实测；`rules.rs:1140-1188` `IGNORED_PREFIXES` |

注意：`git status 2>&1`、`git status 2>/dev/null` **可以**改写（fd 复制/重定向到 /dev/null 由 `strip_trailing_redirects` 剥出再贴回，`registry.rs:2003-2005`），只有**指向文件**的重定向被拒。社区脚本对此有踩坑记录（`hooks/README.md:352`、`test-rtk-rewrite.sh:132-134`）。

---

## ② 命令族全量清单

### 2.1 两条并行路径（先理解这个，再看表）

rtk 的命令覆盖由**两套机制**共同决定，二者都必须知道：

| 机制 | 位置 | 特点 |
|---|---|---|
| **A. 原生 RULES 表** | `src/discover/rules.rs:59-1138`（96 条 `RtkRule`） | 每条含 `pattern`（正则）、`rtk_cmd`（目标形态）、`pipeline_safety`、`category`、`savings_pct`。`classify_command` 用 `RegexSet` 取**最后一个**匹配（`registry.rs:259-262`）——顺序即优先级，最具体的在最后 |
| **B. TOML 过滤器** | `src/filters/*.toml`（28+ 个文件） | `build.rs` 按文件名字典序拼接成单个 TOML blob 嵌进二进制（`src/filters/README.md:4-6`）。命中后改写为 `rtk <原命令>`（`registry.rs:2063-2065`）。开关：`RTK_NO_TOML=1`（`toml_filter.rs:419`） |
| 保底 | `src/core/toml_filter.rs:320` `is_rtk_reserved_command` | 保留命令（git/cargo/json/rewrite…）不得被 TOML 接管 |

`classify_command` 返回三态（`registry.rs:187-323`）：`Supported { rtk_equivalent, category, estimated_savings_pct, status }` / `Unsupported { base_command }`（可能被 TOML 接管）/ `Ignored`。

### 2.2 CLI 顶层子命令全集（本机 1.1.0 `rtk --help` 实测 + `src/lib.rs:182-1108` `enum Commands`）

`enum Commands` 共 **90 个变体**（`src/lib.rs:182` 起，至 `1108`）。

**文件与系统**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `ls` | 目录列举，代理原生 `ls`（透传 `-l -a -h -R`） | `lib.rs:184-188` |
| `tree` | 目录树 | `lib.rs:191-195` |
| `read` | 读文件并智能过滤；`--level none/minimal/aggressive`、`--head-lines`、`--tail-lines`、`--max-lines`、`-n` | `lib.rs:198-219` |
| `smart` | 2 行启发式摘要 | `lib.rs:222-231` |
| `find` | find 结果的紧凑树 | `lib.rs:378-382` |
| `diff` | 超浓缩 diff；同文件 exit 0/1/2 语义 | `lib.rs:390-395` |
| `log` | 日志过滤去重 | `lib.rs:398-401` |
| `json` | JSON 紧凑展示；`--keys-only` | `lib.rs:352-361` |
| `wc` | 字数/行数统计紧凑输出 | `lib.rs:559-563` |
| `grep` | grep 结果压缩（`--max-len`、`--max`、`--context-only`） | `lib.rs:438-468` |
| `rg` | ripgrep 结果压缩 | `lib.rs:471-475` |
| `ast-grep` | ast-grep 结果按文件分组 | `lib.rs:478-482` |
| `deps` | 依赖摘要 | `lib.rs:364-368` |
| `env` | 环境变量过滤 | `lib.rs:371-375` |
| `pipe` | 从 stdin 读、应用过滤器、打印（Unix 管道模式）；`--filter`、`--passthrough` | `lib.rs:851-859` |

**VCS / 代码托管**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `git` | 子命令见 §2.3；全局选项 `-C`、`-c`、`--git-dir`、`--work-tree`、`--no-pager`、`--no-optional-locks`、`--bare`、`--literal-pathspecs` | `lib.rs:234-271` |
| `gh` | GitHub CLI 压缩（`pr/issue/run/repo/api/release`） | `lib.rs:274-280`、`rules.rs:77` |
| `glab` | GitLab CLI 压缩（`mr/issue/ci/pipeline/api/release`），`-R`/`-g` | `lib.rs:283-295`、`rules.rs:86` |
| `gt` | Graphite 堆叠 PR | `lib.rs:1022-1026`、`rules.rs:1123` |

**云 / 容器 / INFRA**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `aws` | AWS CLI 强制 JSON 压缩（STS/S3/EC2/ECS/RDS/CFN/CloudWatch/Lambda/IAM/DynamoDB/EKS/SQS/Secrets） | `lib.rs:298-304`、`cloud/README.md:7` |
| `psql` | PostgreSQL 输出压缩 | `lib.rs:307-311` |
| `curl` | curl 自动 JSON 检测 + schema | `lib.rs:734-738` |
| `wget` | 下载进度条剥离 | `lib.rs:547-556` |
| `docker` | 子命令见 §2.3 | `lib.rs:410-413` |
| `kubectl` | 子命令见 §2.3 | `lib.rs:416-419` |
| `oc` | OpenShift CLI | `lib.rs:422-425` |
| `terraform` / `tofu` / `helm` / `ansible-playbook` / `liquibase` / `pulumi` / `sops` / `gcloud` / `iptables` / `systemctl` / `fail2ban-client` / `ping` / `rsync` / `df` / `du` / `brew` | 均通过 RULES/TOML 覆盖 | `rules.rs:721-1131` |

**构建 / 包管理**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `cargo` | `build/test/clippy/check/fmt/install`（`fmt` 为 Passthrough） | `lib.rs:701-704`、`1619-1651`、`rules.rs:94-103` |
| `pnpm` | `exec/i/install/list/ls/outdated/run/run-script`，`-F/-r/-w` | `lib.rs:314-329`、`1409-1440`、`rules.rs:104-110` |
| `npm` | `exec/run/run-script/rum/urn/x` | `lib.rs:707-711`、`rules.rs:112-118` |
| `npx` | 智能路由（tsc/eslint/prisma → 专用过滤） | `lib.rs:714-718`、`rules.rs:120-126` |
| `bun` | `install/run/build/test/add/remove/pm/x` | `lib.rs:721-724`、`1748-1805` |
| `bunx` | 透传 + 自动过滤 | `lib.rs:727-731` |
| `deno` | Deno 运行时 | `lib.rs:1004-1008` |
| `pip` | pip（自动识别 uv） | `lib.rs:990-995` |
| `uv` | uv run（保留 uv 环境语义） | `lib.rs:997-1002` |
| `poetry` / `composer` / `mix` / `pio` / `shopify` / `swift` / `make` / `just`(TOML) / `mise`(TOML) | 各自过滤 | `rules.rs:960-1045` 等 |
| `dotnet` | 子命令见 §2.3 | `lib.rs:404-407` |
| `gradlew` | Gradle wrapper（build/test/lint） | `lib.rs:1036-1041`、`jvm/README.md:7` |
| `mvn` | Maven wrapper（test/compile/package/install/verify/deploy） | `lib.rs:1044-1049`、`jvm/README.md:12-19` |
| `mvnd` | Maven Daemon，共用 mvn 全部过滤器 | `lib.rs:1052-1056`、`jvm/README.md:31` |
| `sbt` | SBT | `lib.rs:1016-1020` |
| `go` | 子命令见 §2.3 | `lib.rs:1010-1014` |
| `golangci-lint` | `run` 紧凑 + 其他透传 | `lib.rs:1028-1033`、`rules.rs:576` |

**JS / TS 生态**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `tsc` | TS 编译器错误分组 | `lib.rs:652-655`、`rules.rs:187` |
| `lint` | ESLint 违规分组（跨生态路由到 mypy/ruff） | `lib.rs:673-676`、`rules.rs:211`、`js/README.md:8` |
| `prettier` | 格式检查 | `lib.rs:680-683`、`rules.rs:262` |
| `format` | 通用格式检查（prettier / black / ruff format 自动探测） | `lib.rs:687-690`、`system/README.md:11` |
| `ng` | Angular build 表格压缩 | `lib.rs:659-663`、`rules.rs:287` |
| `next` | Next.js build | `lib.rs:666-669`、`rules.rs:296` |
| `jest` | Jest | `lib.rs:625-628`、`rules.rs:321` |
| `vitest` | Vitest | `lib.rs:632-635`、`rules.rs:360` |
| `playwright` | Playwright E2E | `lib.rs:694-697`、`rules.rs:407` |
| `prisma` | `generate/migrate/db push` | `lib.rs:646-648`、`1573-1592`、`rules.rs:431` |

**Python**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `pytest` | pytest（状态机文本解析） | `lib.rs:899-903`、`rules.rs:539` |
| `mypy` | mypy 错误分组 | `lib.rs:906-910`、`rules.rs:512` |
| `ruff` | ruff check/format | `lib.rs:885-889`、`rules.rs:521` |
| `sqlfluff` | SQLFluff（注入 `--format json`） | `lib.rs:892-896`、`rules.rs:531`、`python/README.md:9` |

**PHP**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `php` | `php -l` 语法检查摘要 + `php artisan*` 路由 | `lib.rs:913-917`、`php/README.md:7` |
| `phpunit` / `phpstan` / `pest` / `paratest` / `ecs` / `pint` / `phpt` | 各自压缩 | `lib.rs:920-962`、`rules.rs:654-712` |

**Ruby / Rust / Scala / JVM**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `bundle` / `rake` / `rspec` / `rubocop` | Ruby（自动探测 `bundle exec`） | `rules.rs:595-629`、`ruby/README.md:9-10` |
| （无独立 `cargo` 之外的 Rust 子命令） | — | — |
| `ctest` | CTest | `lib.rs:639-642`、`rules.rs:399` |

**元 / 运维 / 统计**
| 子命令 | 用途 | 依据 |
|---|---|---|
| `init` | 安装 hook 到各 agent（`-g`、`--agent`、`--gemini`、`--codex`、`--copilot`、`--opencode`、`--uninstall`、`--dry-run`、`--trust-filters`…） | `lib.rs:485-544` |
| `gain` | 省 token 汇总 + `--history` | `lib.rs:566` |
| `discover` | 扫历史找漏掉的省 token 机会 | `lib.rs:741-757` |
| `session` | RTK 采纳率 | `lib.rs:760` |
| `learn` | 从错误历史学 CLI 纠正 | `lib.rs:775-797` |
| `cc-economics` | Claude Code 花费 vs rtk 节省 | `lib.rs:597-613` |
| `config` | 配置查看/修改（`--create`） | `lib.rs:616-622` |
| `telemetry` | 遥测同意与数据管理 | `lib.rs:763-766` |
| `llm-proxy` | 透明 LLM 代理 | `lib.rs:769-772` |
| `pipeline` / `methods` / `plugins` / `tasks` | 压缩流水线（`feature = "engine"`，`default = ["engine"]`） | `lib.rs:568-594`、`Cargo.toml:47` |
| `run` | 直接执行 argv，或经 `-c/--shell` 执行命令串 | `lib.rs:800-815` |
| `bypass`（别名 `proxy`） | 不过滤执行但记账 | `lib.rs:817-827` |
| `recall` | 按内容哈希召回被省略的输出 | `lib.rs:830-848` |
| `rewrite` | **本任务核心** | `lib.rs:1096-1101` |
| `hook` | 进程内 hook 处理（`claude/copilot/cursor/gemini/codex/opencode/check`…） | `lib.rs:1104-1107`、`1275-1315` |
| `hook-audit` | hook 改写审计指标（需 `RTK_HOOK_AUDIT=1`） | `lib.rs:1060-1065` |
| `trust` / `untrust` / `verify` | 项目级 TOML 过滤器信任与校验 | `lib.rs:862-882` |
| `err` / `test` / `summary` | 通用跑命令 + 只显错误 / 只显失败 / 启发式摘要（支持 `--shell`） | `lib.rs:332-349`、`428-435` |

### 2.3 有嵌套子枚举的命令族（`src/cmds/` 12 个语言族目录对应）

> 勘误（Lead 2026-11-08 复核）：本标题原写「13 个目录」，实为 **12 个语言族目录**。`src/cmds/` 下共 13 个条目，其中 `mod.rs` 是文件（仅 12 行 `pub mod` 声明），不是命令族目录。按 `mod.rs:3-14` 逐条核对：cloud、dotnet、git、go、js、jvm、php、python、ruby、rust、scala、system = **12**。下文表格 12 行正确。

| 族目录 | 顶层子命令 | 子命令枚举 / 依据 |
|---|---|---|
| `src/cmds/git/` | `git` | `GitCommands`：`diff/log/status/show/add/commit/checkout/push/pull/branch/fetch/stash/worktree/ls-tree` + `external_subcommand` 透传（`lib.rs:1316-1406`）。另有 `gh`/`glab`/`gt` 与独立 `diff`（`git/README.md:23-25`） |
| `src/cmds/cloud/` | `aws`/`docker`/`kubectl`/`oc`/`curl`/`wget`/`psql` | `DockerCommands`（ps/compose(ps/logs/build)）、`KubectlCommands`（get/pods/services/logs）、`OcCommands`（同 kubectl 形）（`lib.rs:1443-1571`）。未知子命令一律 passthrough（`cloud/README.md:8`） |
| `src/cmds/dotnet/` | `dotnet` | `DotnetCommands`：`build/test/restore/format`（`lib.rs:1662-1687`）。内部 `binlog.rs`/`dotnet_trx.rs`/`dotnet_format_report.rs` 只服务它（`dotnet/README.md:7-8`） |
| `src/cmds/go/` | `go` | `GoCommands`：`test/build/vet`（`lib.rs:1689-1714`）；`golangci-lint run` 另 inject `--out-format=json`（`go/README.md:7-9`） |
| `src/cmds/js/` | `pnpm`/`npm`/`npx`/`bun`/`bunx`/`deno`/`tsc`/`lint`/`prettier`/`format`/`ng`/`next`/`jest`/`vitest`/`playwright`/`prisma` | `PnpmCommands`（list/outdated/install/typecheck）（`lib.rs:1409-1441`）；`BunCommands`（install/run/build/test/add/remove/pm/x）+ `BunPmCommands`（ls/run/…）（`lib.rs:1748-1805`）；`DenoCommands`（run/check/lint/test/task/compile/install）（`lib.rs:1807-1845`）；`PrismaCommands`+`PrismaMigrateCommands`（`lib.rs:1573-1617`） |
| `src/cmds/jvm/` | `gradlew`/`mvn`/`mvnd` | 无独立子枚举，相位在 `gradlew_cmd.rs`/`mvn_cmd.rs` 内 `detect_phase` 判定（`jvm/README.md:12-19`、`45-47`） |
| `src/cmds/php/` | `php`/`phpunit`/`phpstan`/`pest`/`paratest`/`ecs`/`pint`/`phpt` | 无子枚举，各文件独立（`php/mod.rs:1-12`） |
| `src/cmds/python/` | `pytest`/`mypy`/`ruff`/`sqlfluff`/`pip`/`uv` | 无子枚举（`python/mod.rs:1-6`） |
| `src/cmds/ruby/` | `bundle`/`rake`/`rspec`/`rubocop` | 无子枚举（`ruby/mod.rs:1-3`） |
| `src/cmds/rust/` | `cargo` | `CargoCommands`：`build/test/clippy/check/install/nextest`（`lib.rs:1619-1660`） |
| `src/cmds/scala/` | `sbt` | `SbtCommands`：`test/compile/run`（`lib.rs:1723-1746`） |
| `src/cmds/system/` | `read`/`ls`/`tree`/`find`/`grep`/`rg`/`ast-grep`/`ctest`/`format`/`json`/`log`/`deps`/`env`/`summary`/`wc`/`pipe` | 无子枚举（`system/mod.rs:1-19`） |
| `src/cmds/` 根 | — | 只有 `mod.rs`，13 行 `pub mod`（`cmds/mod.rs:1-14`） |

### 2.4 原生命中忽略清单（插件可直接视为"不会改"）

- `IGNORED_PREFIXES`（47 条，`rules.rs:1140-1188`）：`cd `、`echo `、`printf `、`export `、`source `、`mkdir `、`rm `、`mv `、`cp `、`chmod `、`chown `、`touch `、`which `、`type `、`test `、`true`、`false`、`sleep `、`wait`、`kill `、`set `、`unset `、`sort `、`uniq `、`tr `、`cut `、`awk `、`sed `、`python3 -c`、`python -c`、`node -e`、`ruby -e`、**`rtk `**、`pwd`、`bash `、`sh `、`then`/`else`/`do`/`for`/`while`/`if`/`case`
- `IGNORED_EXACT`（`rules.rs:1190-1192`）：`cd`、`echo`、`true`、`false`、`wait`、`pwd`、`bash`、`sh`、`fi`、`done`

注意 `rtk ` **已在忽略前缀里**（`rules.rs:1174`）——这是 registry 层的第二道递归防护。

---

## ③ 其它能力（与插件正交，但要知道它们存在）

| 模块 | 职责 | 依据 |
|---|---|---|
| `src/discover/` | **改写热路径**（`registry.rs`）+ 历史分析（`rtk discover`）。词法器 `lexer.rs` 单遍状态机处理引号/转义/重定向/操作符 | `discover/README.md:5-29` |
| `src/learn/` | 从 Claude Code 会话历史检测重复 CLI 错误，可生成 `.claude/rules/cli-corrections.md` | `learn/README.md:1-20` |
| `src/filters/` | 28+ 个内置 TOML 过滤器，被 `build.rs` 拼成单 blob 嵌入二进制 | `filters/README.md:4-6` |
| `src/hooks/` | hook 生命周期（安装/卸载/完整性校验/信任）**不实现改写逻辑**。`decision.rs` 是唯一判决处 | `hooks/README.md:5-14` |
| `src/parser/` | 三层解析基础设施（Full JSON / 降级正则 / 透传截断） | `parser/README.md:7-13` |
| `src/core/` | 领域无关叶子模块：配置、记账、TOML 引擎、tee 恢复、显示、shell 构造、遥测 | `core/README.md:9-19` |
| `src/analytics/` | **只读**仪表盘（`gain`/`cc-economics`/`session`） | `analytics/README.md:5-13` |
| `src/llm_proxy.rs` | 透明 LLM 代理（`rtk llm-proxy`），与命令改写无关 | `lib.rs:769-772`、`llm_proxy.rs` |

---

## ④ 环境变量

`grep RTK_` 全量（`src/` 下 70 处命中，去重后如下）：

| 变量 | 作用 | 是否影响 `rtk rewrite` | 依据 |
|---|---|---|---|
| `RTK_DISABLED=1` | 关闭过滤 | **仅作为「命令文本前缀」生效，不是进程环境变量语义** | 见下方 4.1 |
| `RTK_REWRITE_HOST` | 声明 delegate 身份；仅 `openclaw` 解析为 `ApprovalOwner::Delegate`，把「默认 ask」（verdict=Default）渲染成 **exit 0** | **是**。但插件不该设它（理由见 4.2） | `decision.rs:84`、`123-131`、`144-153`；`lib.rs:1072-1075` |
| `RTK_SUPPRESS_HOOK_WARNING` | 抑制 hook 警告 | 否 | `config.rs:319` |
| `RTK_VERSION` / `RTK_TELEMETRY_DISABLED` / `RTK_TELEMETRY_URL` / `RTK_TELEMETRY_TOKEN` | 遥测 | 否 | `telemetry_cmd.rs:5`、`telemetry.rs:16-17` |
| `RTK_CONFIG_DIR` | 覆盖配置目录 | 间接（`config.toml` 里的 `exclude_commands`/`transparent_prefixes` 影响改写） | `pipeline_config.rs:83`、`config.rs:277-281` |
| `RTK_DB_PATH` / `RTK_TEE_DIR` / `RTK_RECALL_DB` / `RTK_RECALL=0` / `RTK_TEE=0` | 记账与 tee/recall | 否 | `tracking.rs:2003`、`tee_file.rs:105`、`retriever.rs:174`、`config.rs:515-516` |
| `RTK_NO_TOML=1` | 关闭 TOML 过滤器（机制 B） | **是**（关掉一部分改写覆盖） | `toml_filter.rs:419` |
| `RTK_TOML_DEBUG` | TOML 调试输出 | 否 | `toml_filter.rs:896` |
| `RTK_TRUST_PROJECT_FILTERS=1` | 免提示信任项目级过滤器 | 间接 | `trust.rs:106` |
| `RTK_ONRAMP_DISABLED=1` | 关闭 onramp 提示 | 否 | `init/mod.rs:1030` |
| `RTK_HOOK_AUDIT=1` | 打开 hook 审计 | 否（审计旁路） | `hook_cmd.rs:627` |
| `RTK_AUDIT_DIR` | 审计目录 | 否 | `hook_audit_cmd.rs:10` |
| `RTK_POSTHOOK=0` | 关闭 posthook | 否 | `posthook.rs:81` |
| `RTK_PROXY_BIND` / `RTK_PROXY_DB` / `RTK_PROXY_ICM_DB` | llm-proxy 绑定与库 | 否 | `llm_proxy.rs:585`、`816-817` |
| `RTK_PLUGIN_SOURCE` | 插件源 | 否 | `plugins_cmd.rs:16` |
| （测试专用）`RTK_TEST_CMD_WRAPPER_DIR`、`RTK_TEST_KEY_THAT_IS_NOT_SET` | 仅测试 | 否 | `task_cmd.rs:804`、`1162` |

> `RTK_BIN` **在 rtk 上游不存在**——那是插件自己的环境变量（`index.js:83`）。

### 4.1 `RTK_DISABLED` 的真实语义（重要纠正）

- **作为进程环境变量时，对 `rtk rewrite` 无效。** 实测：`RTK_DISABLED=1 rtk rewrite 'git status'` → `exit=3`，stdout=`rtk git status`（未被禁用）。
- 它只在**命令文本里作为 env 前缀**时生效：`RTK_DISABLED=1 git status` → exit 1 + stderr 警告（`registry.rs:1898-1908`；实测一致）。
- 其他位置还有两处环境变量检查，但都跟 `rewrite` 无关：`posthook.rs:78`（posthook 直接返回）、`config.rs:515`（tee/recall）。
- 参考 hook 脚本也**不**检查 `RTK_DISABLED` 环境变量（`hooks/claude/rtk-rewrite.sh` 全文无此判断）。

**结论**：插件 `index.js:138` 的 `if (process.env.RTK_DISABLED === '1') return super.execute(spec)` 是**插件自己加的额外安全阀**，上游没有等价语义。留着没害处（用户设了它就完全不改写，行为可预期），但文档不能写成「rtk 的开关」——这是插件行为。

### 4.2 `RTK_REWRITE_HOST` 为什么不建议插件设置

- 它把 `verdict=Default` 的 ask **放松成 exit 0**（`decision.rs:144-153`）。对本插件无收益：插件无论 exit 0 还是 exit 3，只要有 stdout 就采用改写。
- 反面风险明确：官方脚本**主动清除**这个变量（`env -u RTK_REWRITE_HOST`，`hooks/claude/rtk-rewrite.sh:55-59`），注释说明「继承来的值不得到达这里，只有自己设置它的 delegate 才能依赖它」。
- 若插件继承了一个残留的 `RTK_REWRITE_HOST=openclaw`，只能换来 exit 0 而非 3，**不会**改变改写内容，也不会改变 deny（`decision.rs:88-90` 明确 deny 对任何 delegate 都是 exit 2）。因此是**低危但无收益**。
- 建议：插件在 spawn 时显式删除该变量（照抄 `env -u` 的意图），或在文档里明确「本插件不依赖 `RTK_REWRITE_HOST`」。**推断**：Node 侧可用 `env: {...process.env, RTK_REWRITE_HOST: undefined}` 的方式剔除。

---

## ⑤ 1.1.0 → 1.2.0-rc 变更

### 5.1 版本号先说清楚

| 来源 | 值 |
|---|---|
| 本机安装 | `rtk 1.1.0`（实测） |
| 上游 HEAD tag | `dev-1.2.0-rc.620`（`git tag` 实测，指向 `bd7f87e`） |
| 上游 `Cargo.toml:25` | `version = "0.49.0"` |
| 上游 `CHANGELOG.md:8` 最新条目 | `## [0.49.0] (2026-09-11)` |
| 上游 `hooks/claude/rtk-rewrite.sh:4` | `Requires: rtk >= 0.23.0` |

**结论**：`Cargo.toml` 的 `0.49.0`、本机 `1.1.0`、tag 的 `1.2.0-rc.620` 三个数字**不是同一条语义化版本线**——`dev-*` tag 是 nightly/RC 构建标记，`Cargo.toml` 是 release-please 管的发布版本，而本机 1.1.0 是某个更晚的正式发布（或不同分发渠道）。**不能**用「1.1.0 落后于 1.2.0-rc.620」这样简单的比较来推断功能差异。

要判定能力差异，唯一可靠办法是**按命令实测**（本报告 §2.2 的表都以本机 1.1.0 `--help` + 实测校验过）。

### 5.2 与 rewrite / 退出码 / 命令覆盖相关的 CHANGELOG 条目

`CHANGELOG.md` 的条目止于 0.49.0（2026-09-11），**没有 1.1.0 之后的条目**。因此只能从代码现状反推「1.1.0 时已有 / 可能没有」的特性。

在 0.49.0 窗口内、与 rewrite 强相关的条目（`CHANGELOG.md:19-20`、`58-60`）：

| 条目 | 影响 |
|---|---|
| `feat(rewrite): peel process wrapper prefixes`（`CHANGELOG.md:19`，b17dda3） | 支持剥 `sudo`/`env`/`xargs` 等前缀后再匹配。**注意**：`sudo` 在另一条修复里被改成**不改写**（`CHANGELOG.md:60`，d20db46）——两处行为差异，实测 `sudo rtk git status` → exit 1，与该修复一致 |
| `feat(rewrite): rewrite in pipe when consumer is safe`（`CHANGELOG.md:20`，b0d471e） | 管道 final stage 安全改写（实测 `cat a.txt \| grep foo` → `rtk grep foo`） |
| `fix(rewrite): PipelineSafety enum, quote-aware consumer args, fd-dup redirects, stage rewrite consolidation`（`CHANGELOG.md:58`，148e0d4） | `PipelineSafety` 枚举（`rules.rs:4-20`）、fd 复制重定向可改写 |
| `fix(rewrite): stop rewriting sudo commands (pass them through)`（`CHANGELOG.md:60`，d20db46） | `sudo` 前缀不解改写 |

### 5.3 本机 1.1.0 已具备的上游 HEAD 特性（实测确认，说明 1.1.0 并不"旧"）

| 特性 | 上游依据 | 1.1.0 实测 |
|---|---|---|
| exit 3 契约 + `Default → 3` | `rewrite_cmd.rs:242` | ✅ `git status` → exit 3 |
| 复合/管道逐段改写 | `registry.rs:1284-1397` | ✅ `&&`/`;`/`\|` 全部正确 |
| 恒等返回（不做抑制） | `decision.rs:412-417` | ✅ `rtk git status` → 原样 exit 3 |
| `RTK_DISABLED=` 前缀警告 | `registry.rs:1902-1908` | ✅ exit 1 + stderr 文案一致 |
| `head`/`tail` → `rtk read --head-lines/--tail-lines` | `registry.rs:1399-1435` | ✅ |
| `python3 -m pytest` → `rtk pytest` | `python/README.md:15` | ✅ |
| `--skip-env` 全局 flag | `lib.rs:101-103` | ✅ `rewrite --help` 有 |
| `RTK_REWRITE_HOST` 文档 | `lib.rs:1072-1075` | ✅ `--help` 文本含该变量名 |
| `mvnd` 子命令 | `lib.rs:1052-1056` | ✅ `rtk --help` 列出 |

**结论**：本机 1.1.0 已经实现了上游 HEAD 的 rewrite 契约（含 exit 3、恒等返回、复合命令、`RTK_DISABLED=` 前缀）。**插件没有任何"等升级才能用"的阻塞点。**

### 5.4 观察到的覆盖差异（仅能确认 1.1.0 的行为，无法断言上游新在哪）

| 命令 | 1.1.0 实测 | 备注 |
|---|---|---|
| `vitest run` | `rtk vitest`（**`run` 字面量被吞掉**） | `vitest run foo.test.ts` → `rtk vitest foo.test.ts`（参数保留）。**推测**是 `--` 前的位置参数处理，属 rtk 侧行为，插件不受影响（只管透传 rtk 的输出） |
| `ls \| wc -l` / `git log \| wc -l` | exit 1（`wc` 未列入 pipeline-safe） | `hooks/README.md:344` 说「Initially limited to argument-safe `grep`, `rg`, and `wc`」——文档与实测不符，**以实测为准**（`wc` 当前不在 `PipelineSafety` 放行集合） |
| `pnpm test` | exit 1（规则只覆盖 `exec/i/install/list/ls/outdated/run/run-script`） | `rules.rs:105` |
| `cat -v file` | exit 1 | `registry.rs:2027-2032` |
| `docker ps` / `kubectl get pods` / `aws s3 ls` / `dotnet build` / `go test ./...` / `./gradlew build` / `ruff check .` / `terraform plan` / `make build` / `mvn test` / `php artisan test` / `pytest` / `jest --coverage` / `ctest -j4` | 全部 exit 3 + 对应 `rtk ...` | 覆盖良好 |

---

## ⑥ 对插件的直接影响结论

### 6.1 递归防护：`startsWith('rtk ')` 远不够 —— 这是必须改的第一项

上游**没有单一的「已改写」标记**。`rtk rewrite` 用 `cmd_part.starts_with("rtk ") || cmd_part == "rtk"` 判定（`registry.rs:2008`、`836`），registry 的 `IGNORED_PREFIXES` 里另有一条 `"rtk "`（`rules.rs:1174`），`discover::is_already_rtk` 也是同一个前缀判断（`discover/mod.rs:295-297`）。**全部是大小写敏感、仅字面 `rtk ` 前缀、不认路径形式。**

注意 `strip_absolute_path` 只剥 **Unix** 路径（含 `/` 的首词才会被处理，`registry.rs:577-598`），Windows 反斜杠路径不剥。

本机实测各形态（`rtk rewrite "<cmd>"` 的返回）：

| 插件可能遇到的命令形态 | rtk 自己怎么处理 | 实测 exit / stdout | 插件当前判定（`index.js:141`） | 风险 |
|---|---|---|---|---|
| `rtk git status` | 识别为已 rtk，**原样返回** | 3 / `rtk git status` | 拦住 ✅ | 无 |
| `rtk` | 识别为已 rtk | 3 / `rtk` | `startsWith('rtk ')` 为 false，`startsWith('rtk.exe ')` 为 false → **不拦** | 走一次 rewrite，得到相同字符串，`rewritten !== command` 为 false → 不采纳。**功能上安全，多一次 spawn** |
| `rtk.exe git status` | 不识别（`rtk.exe` ≠ `rtk`）→ 视作普通命令 → 无等价 | **1 / 空** | 拦住 ✅（`startsWith('rtk.exe ')`） | 无 |
| `C:\Users\Sjc\.local\bin\rtk.exe git status` | 不识别 → 无等价 | **1 / 空** | **不拦** | 走一次 rewrite，得 exit 1 → null → 执行原命令。安全但浪费 |
| `RTK.EXE git status`（大写） | 不识别 → 无等价 | **1 / 空** | **不拦**（大小写敏感） | 同上 |
| `RTK git status` | 不识别 → 无等价 | **1 / 空** | **不拦** | 同上 |
| `"rtk" git status`（带引号） | 不识别 → 无等价 | **1 / 空** | **不拦** | 同上（但带引号在 shell 里通常本来就不执行） |
| `./rtk git status` | 不识别 → 无等价 | **1 / 空** | **不拦** | 同上 |
| `/usr/local/bin/rtk git status` | `strip_absolute_path` 剥成 `rtk ...` → 识别为已 rtk | 3 / `/usr/local/bin/rtk git status`（**原样**） | **不拦** | 走一次 rewrite 得相同串 → 不采纳。安全 |
| `ls -la && rtk git status` | 复合命令，逐段；后段已 rtk 原样 | 3 / `rtk ls -la && rtk git status` | **不拦**（首词是 `ls`） | ✅ 正确采纳（前段需改写）。**这条说明前缀拦截只能看首词，不能拦整串** |
| `rtk rtk git status` | 原样返回 | 3 / `rtk rtk git status` | 拦住 ✅ | 无 |
| `sudo rtk git status` | sudo 不改写 → 无等价 | **1 / 空** | 不拦 | 安全 |
| `RTK_DISABLED=1 rtk git status` | env 前缀 + 已 rtk | 3 / `RTK_DISABLED=1 rtk git status` | 不拦（首词是 `RTK_DISABLED=1`） | 得相同串 → 不采纳。安全 |

**结论与要求**：
1. 现有 `startsWith('rtk ') || startsWith('rtk.exe ')` 在**所有形态下都不会导致死循环或错误执行**——因为 rtk 对不认识的形态一律 exit 1（→ null → 执行原命令），对认识的形态原样返回（→ `rewritten === command` → 不采纳）。**这是插件"意外安全"的原因，但它依赖 rtk 的宽容，不是插件自己的保证。**
2. 仍然**必须加固**，理由：(a) 每次对已是 rtk 的命令白跑一次 spawn（尤其在 `rtk rtk`、绝对路径、大写变体下）；(b) 若把等价判断改成"有 stdout 就采用"（错误改法），上面 `rtk`、`/usr/local/bin/rtk ...`、`RTK_DISABLED=1 rtk ...` 三种会得到恒等串，若又被误判为"变了"就会写回同样的命令——无功能危害但语义错。**(c) 最实际的危害**：`rtk` 裸命令与 `rtk   git status`（多空格）等形态当前都会走到 spawn。
3. 正确的加固方向：抽成**纯函数** `isAlreadyRtk(command)`，覆盖
   - 首词（引号感知、按 `;&|` 与 `&&`/`||` 切分后任一段）等于 `rtk` / `rtk.exe`（大小写不敏感）
   - 或首词 basename（去 `\` 与 `/` 前缀、去包裹引号）等于 `rtk` / `rtk.exe`
   - 或在 env 前缀（`^\w+=`）之后重复上述判断
   - **并且**保留「`rewritten !== command` 才采纳」这条兜底（现有 `index.js:146` 已有，必须保留，它是最后一道保险）
4. **不要**把「整串 startsWith」当唯一规则：`ls -la && rtk git status` 必须被改写（首段需要 rtk），所以判定必须是**分段感知**的，不能因为串里出现 `rtk ` 就整体跳过。

### 6.2 退出码处理：方向对，但写法要收紧

现行 `index.js:101-133` 的判定链：

```
!err                        → resolve(out || null)        // 采纳（exit 0）
err.code === 'ENOENT'       → 警告一次，null
err.killed                  → 警告超时，null
Number(err.code) === 1      → 静默，null
out 非空                     → resolve(out)                // 采纳（典型 exit 3）
else                        → 警告，null
```

按上游契约（§1.2）逐条核对：

| 退出码 | 上游含义 | 现行处理 | 判定 |
|---|---|---|---|
| 0 | 有改写 + allow 覆盖 | `!err` → 采纳 stdout | ✅ **正确**。注意上游 stdout 无尾换行，`String(stdout).trim()` 安全（但会连带去掉命令首部空格——见 6.4） |
| 1 | 无改写 | 静默 null | ✅ 正确，且与 `rewrite_cmd.rs:123` 一致 |
| 2 | deny 命中 | 落到 `else if (out)`：无输出 → 最后 `else` 警告 + null | ✅ 功能正确（执行原命令），❌ **会产生误导性警告**「exit 2 with no output」。建议把 exit 2 单独静默处理——deny 是宿主的权限决策，不是插件的错误 |

> **关于 exit 2 是否可能带输出（已核实并纠正）**：`rtk rewrite` 路径下 **exit 2 恒定无输出**。`src/hooks/rewrite_cmd.rs:122` 的 `HookDecision::Deny => std::process::exit(2)` 直接退出，不做任何 `print!`；全仓 `process::exit(2)` 仅此一处（`rewrite_cmd.rs:235` 是注释）。本机实测 deny 场景亦为空。
> 但 `rtk rewrite --help` 的文本（`src/lib.rs:1082-1084`）写着「2 - a deny matched... **A message printed**: an rtk pipeline rule denied or routed the command, block it with that message」——这是**过期/错位的文档**：pipeline 规则的 deny 发生在 `posthook`/pipeline 层，不经过 `rewrite_cmd`。因此：
> - 插件**不需要**为「exit 2 带消息」写防御逻辑；
> - 但把 exit 2 显式静默化仍是**稳健性改进**（避免将来 rtk 若真的补上该输出时被当成命令执行），不是当前缺陷。
| 3 | 有改写 + ask/无规则 | `out` 非空 → 采纳 | ✅ 正确，但**它藏在 `else if (out)` 这个"兜底"分支里**，注释只说「e.g. exit 3」。建议显式写出 `Number(err.code) === 3` 分支 |
| 其他 | 未定义 | `out` 有则采纳，无则警告 | 可接受（fail-safe） |
| `err.killed` | 超时 | 警告 + null | ✅ 正确 |
| ENOENT | rtk 不在 PATH | 警告一次 + null | ✅ 正确，与参考实现 `rtk-rewrite.sh:21-24` 的意图一致（但参考实现直接 exit 0 不告警每次） |

**需要改的点**：
- 把 exit 2 与 exit 3 提为**显式分支**，不要依赖 `else if (out)` 的兜底语义。当前代码在 rtk 未来若给 exit 2 也输出内容（实际上有帮助文案的可能，见 `lib.rs:1083-1084` 文档：「A message printed: an rtk pipeline rule denied or routed the command, block it with that message」）时会**把 deny 消息当成命令去执行**——这是**真实的隐患**。
  > ⚠️ 关键：`lib.rs:1082-1084` 明确写了 **exit 2 也可能有消息打印**（pipeline 规则 deny/路由），此时「用该消息阻断命令」。现行代码 `else if (out) resolve(out)` 会把这条消息**当作改写后的命令交给 shell 执行**。虽然本机 1.1.0 实测未触发（输出空），但契约允许。**必须修**。
- `Number(err.code)` 的用法：Node v24 `execFile` 把子进程退出码放在 `err.code`（number），spawn 失败放字符串。`index.js:94-99` 的注释已记录这一点，判断 `Number(err.code) === N` 是稳的。但 `err.code === 'ENOENT'` 与 `Number(err.code) === 1` 的顺序也要保持（ENOENT 先判），现有顺序正确。

### 6.3 复合命令 / 管道：不要拆，整体透传

依据 §1.6：rtk 自己处理 `&&`/`||`/`;`/`|`/`|&`/`&`/多行，逐段改写并原样保留分隔符。插件**不应**拆分命令。

同时要注意：
- 返回值**不是**「输入加一个 `rtk ` 前缀」，而是可能多处插入。
- 若 rtk 判断整串不可改（如含 `$(...)`），返回 exit 1 → 插件执行原串，正确。
- 若命令含**指向文件**的重定向（`> out.txt`），rtk exit 1 → 原串执行。这是 rtk 的保守策略，插件无需补偿。
- 多行命令：rtk 会逐行改写（实测）。插件传入含 `\n` 的 `spec.command` 时不会被破坏。

### 6.4 参数保真与空白处理

- 上游 `print!` 输出**无尾换行**（`rewrite_cmd.rs:113`），现行 `.trim()` 安全。
- 但 `.trim()` 同时会剥除**首部空白**。若原始命令是 `  git status`（前导空格），rtk 内部会 `trim()` 后改写（`registry.rs:806`），返回 `rtk git status`（无前导空格）。插件拿到后再与 `spec.command`（`  git status`）比较 → 不相等 → 采纳。这是**正确**的（前导空格对 shell 无意义）。
- **不要**改成 `trimEnd()` 以"保留前导空白"——rtk 本身不保留，会引入不一致。
- `rewritten !== command` 的比较是**字节级**（照抄 `decision.rs:408-410` 的警告：rtk 返回的是 trimmed 字符串，仅空白不同的命令不会被抑制）。插件用 `spec.command`（未 trim）与返回值比，可能因前导空白被判"变了"——无害。

### 6.5 环境变量接入建议

| 变量 | 插件现状 | 建议 |
|---|---|---|
| `RTK_BIN` | ✅ 已支持（`index.js:83`） | 保留。插件私有，上游无此名 |
| `RTK_DISABLED=1` | ✅ 已支持（`index.js:138`），但语义是**插件自加** | 保留；文档措辞改为「本插件的全局开关」，不要写成 rtk 的开关。若想与 rtk 语义对齐，可额外支持「命令文本前缀 `RTK_DISABLED=`」（rtk 自己就会 exit 1，插件无需做） |
| `RTK_REWRITE_HOST` | 未处理 | 建议 spawn 时剔除（照抄 `rtk-rewrite.sh:59` 的 `env -u` 意图）。低危，但消除「继承残留值」的不确定性 |
| `RTK_NO_TOML` | 未处理 | 无需处理。但它会影响 rtk 的改写覆盖（关掉机制 B），插件透传即可，用户自己设 |
| `RTK_CONFIG_DIR` / `RTK_TRUST_PROJECT_FILTERS` | 未处理 | 无需处理（影响 rtk 内部规则加载，插件无需关心） |

### 6.6 命令覆盖：**无需白名单**

- 覆盖由 rtk 内部两套机制（原生 RULES + TOML）决定，**全部在 rtk 进程内**。插件只要把命令原样传给 `rtk rewrite`，新增命令族（cloud/dotnet/go/jvm/php/python/ruby/rust/scala/system 等）**自动透明受益**。
- 插件**不应**维护任何命令白名单。现行 `index.js` 没有任何白名单，✅ 正确，**不要引入**。
- 若将来非要按命令分流（例如为了性能跳过明显无等价的命令），应该**数据驱动**（从 rtk 导出规则），而不是硬编码——但当前无必要，**YAGNI**。

### 6.7 必须改 / 建议改 / 不要动

**必须改（有真实隐患）**
1. **递归防护抽成纯函数并加固**：覆盖 `rtk` / `rtk.exe` / 绝对路径 / 大小写 / 引号 / env 前缀 / 复合分段。当前形态虽"意外安全"，但依赖 rtk 宽容且每次白跑 spawn。
2. **保留 `rewritten !== command` 兜底**（`index.js:146`）——这是最后一道保险，任何加固都不能删它。
3. **exit 2 显式静默化**（稳健性而非缺陷）：当前落到 `else if (out)` 兜底并打印误导性警告。按源码 exit 2 恒无输出（`rewrite_cmd.rs:122`），但显式分支能与 `lib.rs:1082-1084` 那份（过期的）契约描述保持防御一致。

**建议改（正确性/可维护性）**
4. exit 3 显式分支 + 注释改为「exit 0/3 都是改写成功」，并引用 `rewrite_cmd.rs:71-90` 的契约表。
5. spawn 时剔除 `RTK_REWRITE_HOST`。
6. 顶部注释（`index.js:94-99`）里的版本信息「rtk 0.50.0 on Windows」与「--help 文档写 exits 0」的措辞更新为：**`--help` 的条件句被误读；exit 3 是"有改写但无 allow 规则"的常态**，引用 `rewrite_cmd.rs:242`。

**明确不要动**
7. **不要**拆分复合命令/管道（rtk 自己处理）。
8. **不要**引入命令白名单（覆盖由 rtk 内部决定）。
9. **不要**用 stderr 判定成败（参考实现 `2>/dev/null`）。
10. **不要**把 `RTK_DISABLED` 写成 rtk 的开关（它是命令前缀语义，进程环境变量对 `rewrite` 无效）。
11. **不要**改成「有 stdout 就采用」——必须保留与原命令的相等比较。

### 6.8 待实现者注意的 rtk 自身「坑」

| # | 坑 | 依据 |
|---|---|---|
| 1 | `--help` 的退出码说明是**条件句**，默认无规则机器上一切可改命令都是 exit 3 | `lib.rs:1069-1093`、`rewrite_cmd.rs:242` |
| 2 | `rtk rewrite` 不做恒等抑制，已是 rtk 的命令原样回吐 | `decision.rs:412-417` |
| 3 | `rtk rewrite --help` 关于 exit 2「可能带消息」的描述与实际实现不符（实际恒无输出） | `lib.rs:1082-1084` vs `rewrite_cmd.rs:122` |
| 4 | `RTK_DISABLED` 作为**环境变量**对 rewrite 无效，只有命令文本前缀有效 | 实测 + `registry.rs:1898-1908` |
| 5 | `rtk rewrite` 无 `--shell` flag | `rewrite --help` 实测 |
| 6 | 多 argv 会被 `join(" ")`，含空格的命令必须作为**单个** argv 传（现行 `execFile` 正确） | `lib.rs:3739` |
| 7 | `hooks/README.md:344` 声称 `wc` 是 pipeline-safe，实测 `ls \| wc -l` → exit 1，文档过期 | 实测 |
| 8 | `vitest run` → `rtk vitest`（`run` 被吞） | 实测，rtk 侧行为，插件无需补偿 |
| 9 | 版本号三轨不一致（`Cargo.toml` 0.49.0 / 本机 1.1.0 / tag 1.2.0-rc.620），不能做语义化比较 | `Cargo.toml:25`、实测 |
| 10 | `strip_absolute_path` 只处理 Unix 路径，Windows 反斜杠不剥 | `registry.rs:577-598` |
| 11 | `sudo` 前缀被**故意**不改写（与「剥 wrapper 前缀」的 feat 相反） | `CHANGELOG.md:60`、实测 `sudo rtk git status` → exit 1 |

---

## 附：实测环境与方法

- 平台：Windows，MSYS bash（`ops_bash`，非 WSL）
- `rtk --version` → `rtk 1.1.0`
- 上游源码：`/d/Code/_upstream/rtk`，branch `develop`，HEAD `bd7f87e`，tag `dev-1.2.0-rc.620`（未修改）
- 实测方法：`out=$(rtk rewrite "$cmd"); echo "exit=$? out=[$out]"`（部分用例重定向到 `/tmp` 再 cat，避免引号被 shell 吃掉）
- 「源码结论」与「本机实测」在正文中已分别标注；两者冲突处以实测为准并注明（如 §5.4 的 `wc` 管道）
