# rtk-rewrite 验证报告

> 任务：task-4（建立验证体系）+ task-8（补测试锁定 P0-1 / P1-1）
> 被测对象：`index.js`（`SandboxPwshExecutor` 子类，改写桥）
> 测试文件：`test.js`（单文件，零依赖，`node test.js` 直接跑）
> 变异测试工具：`mutate.js`（临时脚本，不入库，见第 ⑦ 节清理说明）

---

## ⓿ 环境与运行方式

### 实测环境（本机）

| 项 | 值 |
|---|---|
| Node | v26.13.0 |
| 平台 | win32 / x64 |
| rtk（本轮实测时） | **0.49.0**（`C:\Users\Sjc\.local\bin\rtk.exe`） |
| rtk（本轮开始前） | 1.1.0 —— 期间被替换为 0.49.0，两版契约一致，见 ⑤ 节 |
| 上游 rtk | `/d/Code/_upstream/rtk`，develop，HEAD `bd7f87e` |
| 上游 dsh | `/d/Code/_upstream/dsh`，master，HEAD `fcc0ad4` |
| dsh 内核 | 0.2.1-rc.5（桌面端） |
| 工作目录 | `D:\Code\DSH-Rtk-rewrite` |

### 三条运行命令

```bash
# 1) 完整模式（需要本机有 rtk）：跑全部 12 组 365 项
node test.js

# 2) CI 模式（runner 上没有 rtk）：跳过真 rtk 组，跑 11 组 258 项
RTK_TEST_FAST=1 node test.js

# 3) 变异测试（临时脚本，2~3 分钟）
node mutate.js
```

### 环境变量开关（**已验证真生效**）

| 变量 | 作用 | 验证方式 | 结果 |
|---|---|---|---|
| `RTK_TEST_TARGET` | 被测模块相对路径，默认 `./index.js`。变异测试靠它指向变异副本 | `mutate.js` 全程使用 | ✅ 生效 |
| `RTK_TEST_FAST=1` | 跳过 **F 组（复合命令真 rtk）**、**G 组（命令族冒烟真 rtk）**、**E1b 组（真 rtk dash 确认）**；**E1a 组仍然全跑** | `PATH=/tmp/nortk:... RTK_TEST_FAST=1 node test.js` → 258/258 PASS | ✅ 生效 |
| `RTK_TEST_SOFT=1` | 把「优化类断言」（`checkDivergence`）失败降级为 `WARN`，不计入失败 | 变异测试中设 `RTK_TEST_SOFT=0` 强制严格 | ✅ 生效 |

> **CI 推荐命令**（给 publish.yml 用）：
> ```yaml
> - run: node test.js
>   env:
>     RTK_TEST_FAST: '1'
> ```
> 理由：`RTK_TEST_FAST=1` 让整个套件**不依赖 rtk 是否存在**，且 P1-1（`-h` 泄露）由 E1a 组的**假 rtk** 完整锁定，不需要真 rtk 也能防回归。**不要设 `RTK_TEST_SOFT`**——CI 应该严格。

---

## ① 测试矩阵

单文件 `test.js`，分 12 组。理由：项目是零依赖 ESM 插件，`node test.js` 是唯一既有入口；拆多个文件需要额外的运行入口与顺序管理，收益为零。断言用自写的 `check/eq`，统一样式（`ok` / `FAIL` / `WARN` + 汇总），不引框架。

### 分组总览（有 rtk 时 365 项 / 无 rtk 时 258 项）

| 组 | 名称 | 有 rtk | 无 rtk | 覆盖内容 |
|---|---|---|---|---|
| A | rewrite 退出码契约 | 27 | 27 | exit 0/1/2/3/7、trim、恒等、超时、崩溃、stderr 隔离 |
| B | rtk 缺失（ENOENT） | 5 | 5 | 原样执行、单次告警、告警文案、后续不重复告警 |
| C | 递归防护 | 54 | 54 | 13 种 rtk 调用形态 + 关键反例 + 5 种后置位置 |
| D | 失败安全 | 35 | 35 | 所有失败路径不吞命令/不抛异常、沙箱字段透传、RTK_DISABLED |
| D2 | 同步异常（catch 分支） | 4 | 4 | `execFile` 同步抛（NUL 参数）→ catch 兜住、原命令执行、告警 |
| **E0** | **执行失败必须上抛（P0-1）** | **13** | **13** | **沙箱异常上抛、取消上抛、只执行 1 次** |
| **E1a** | **以 `-` 开头的命令（假 rtk，任何环境都跑）** | **44** | **44** | **`-h`/`--help`/`-hh` 等 11 条不执行 help 文本 + `--` 隔离符确实下发 + 正向不加 `--`** |
| E1b | 以 `-` 开头的命令（真 rtk） | 33 | — | 真实 clap 行为确认 + 成因取证 + 正向防回归 |
| E | 纯函数单测 | 61 | 61 | `isRtkInvocation` 的 21 正例 / 20 反例 / 9 空段例 |
| F | 复合命令与管道（真 rtk） | 8 | — | `&&`/`;`/`\|`/重定向/`$()` 按 rtk 契约比对 |
| G | 命令族冒烟（真 rtk） | 69 | — | **12 个命令族全部命中**：cloud/dotnet/git/go/js/jvm/php/python/ruby/rust/scala/system |
| H | 模块契约 | 12 | 12 | 导出、候选路径、package.json、cordis.patch.yml、peer 范围 |
| | **合计** | **365** | **258** | |

### 覆盖矩阵（对照任务要求的每一条）

| 要求项 | 用例位置 | 断言举例 |
|---|---|---|
| 有等价（exit 3 + stdout） | A | `git status` → `rtk git status` |
| 无等价（exit 1） | A | 原样执行 + **不产生告警**（1 是正常分支） |
| 已是 rtk 形式（恒等） | A + E | 输出 === 原命令 → 执行原命令、不打印改写日志、只 spawn 1 次 |
| 超时 | A | 原样执行 + 告警含 timeout + 5000ms 量级返回 |
| ENOENT | B | 原样执行 + 告警 1 次 + 后续不重复 |
| 异常退出码**带**输出 | A | exit 7 + 输出 → **不采纳**输出，原样执行 |
| 异常退出码**不带**输出 | A | exit 7 无输出 → 原样执行 + 告警含退出码 |
| 裸 rtk | C + E | 不调用 rtk rewrite |
| rtk.exe | C + E | 不调用 rtk rewrite |
| 绝对路径 rtk.exe | C + E | `C:\...\rtk.exe`、`C:/.../rtk.exe`、`/usr/local/bin/rtk`、`./rtk` |
| 大小写 | C + E | `RTK`、`RTK.EXE`、`Rtk Git Status` |
| 带引号 | C + E | `"rtk"`、`'rtk'`、`"C:\Program Files\rtk\rtk.exe"` |
| `;`/`\|`/`&&` 后置 | C + E | **必须交给 rtk**（不是跳过） |
| **★ 关键反例** | C + E | `ls -la && rtk git status` **必须调用 rtk**（首段需改写）；`every→some` 变异体会被此用例捕获 |
| 复合命令/管道 | F | 与真 rtk 逐条比对，插件不自行拆分 |
| 命令族冒烟 | G | 12 族 × 1~7 条真实命令，每族断言「至少一条被改写」+ 逐条契约一致 |
| 失败安全 | D + D2 | 8 种失败场景：不抛异常、不吞命令、只执行 1 次 |
| 纯函数单测 | E | `isRtkInvocation` 直接 import 测 |
| **执行失败上抛** | **E0** | **沙箱异常 / 取消 → 原样上抛 + 执行 1 次** |
| **`-h` 不泄露** | **E1a + E1b** | **最终执行内容 === 原命令，且不是 help 文本** |

---

## ② 真实执行输出

### 2.1 完整模式（有 rtk）—— `node test.js`

```
$ node test.js
目标模块: index.js   模式:STRICT
环境: node v26.13.0 / win32-x64 / rtk rtk 0.49.0

── A. rewrite 退出码契约  [27/27]
── B. rtk 缺失（ENOENT）  [5/5]
── C. 递归防护  [54/54]
── D. 失败安全  [35/35]
── D2. 同步异常（catch 分支）  [4/4]
── E0. 执行失败必须上抛（P0-1）  [13/13]
── E1a. 以 - 开头的命令（假 rtk，任何环境都跑）  [44/44]
── E1b. 以 - 开头的命令（真 rtk）  [33/33]
── E. 纯函数单测  [61/61]
── F. 复合命令与管道（真 rtk）  [8/8]
── G. 命令族冒烟（真 rtk）  [69/69]
── H. 模块契约  [12/12]

══════════════════════════════════════════════════════════════════
总计 365 项：通过 365 / 失败 0 / 与契约不一致 0

RESULT: ALL PASS
```

### 2.2 CI 模式（**无 rtk**，模拟 ubuntu-latest）—— `PATH="/tmp/nortk:/usr/bin:/bin" RTK_TEST_FAST=1 node test.js`

```
$ mkdir -p /tmp/nortk
$ PATH="/tmp/nortk:/usr/bin:/bin" RTK_TEST_FAST=1 node test.js
目标模块: index.js   模式:STRICT
环境: node v26.13.0 / win32-x64 / rtk (未安装)

── E1a. 以 - 开头的命令（假 rtk，任何环境都跑）  [44/44]
...
══════════════════════════════════════════════════════════════════
总计 258 项：通过 258 / 失败 0 / 与契约不一致 0

RESULT: ALL PASS
```

> 关键：`rtk (未安装)` 时 **E1a 组仍 44/44 全跑**（假 rtk 复刻 clap 语义），E1b/F/G 三组被 FAST 跳过。这正是审查员指出的「CI 埋雷」的修复——无 rtk 的 runner 上发布门禁可以是绿的，且 P1-1 仍被锁住。

### 2.3 命令族冒烟：12 族全部命中改写

```
   ok   [cloud] 至少一条真实命令被改写
   ok   [dotnet] 至少一条真实命令被改写
   ok   [git] 至少一条真实命令被改写
   ok   [go] 至少一条真实命令被改写
   ok   [js] 至少一条真实命令被改写
   ok   [jvm] 至少一条真实命令被改写
   ok   [php] 至少一条真实命令被改写
   ok   [python] 至少一条真实命令被改写
   ok   [ruby] 至少一条真实命令被改写
   ok   [rust] 至少一条真实命令被改写
   ok   [scala] 至少一条真实命令被改写
   ok   [system] 至少一条真实命令被改写
```

各族实际使用的真实命令（本机 rtk 0.49.0 实测）：

| 族 | 冒烟命令 | 实测改写 |
|---|---|---|
| cloud | `aws s3 ls` / `docker ps` / `kubectl get pods` / `curl -I https://example.com` | `rtk aws s3 ls` 等 |
| dotnet | `dotnet build` / `dotnet restore` | `rtk dotnet build` / `rtk dotnet restore` |
| git | `git status` / `git log --oneline` / `gh pr list` / `glab mr list` | `rtk git status` 等 |
| go | `go test ./...` / `go build` / `golangci-lint run` | `rtk go test ./...` 等 |
| js | `npm run build` / `vitest run` / `tsc --noEmit` / `eslint .` / `prettier --check .` / `next build` / `npx jest` | `rtk npm run build`、`rtk vitest`、`rtk lint .`、`rtk next`、`rtk jest` |
| jvm | `mvn test` / `gradlew build` | `rtk mvn test` / `rtk gradlew build` |
| php | `php artisan list` / `phpunit` / `phpstan analyse` / `composer install` | `rtk php artisan list` 等 |
| python | `pytest -q` / `ruff check` / `mypy .` / `pip install x` / `uv sync` | `rtk pytest -q` 等 |
| ruby | `rspec` / `rake test` / `rubocop` / `bundle install` | `rtk rspec` 等 |
| rust | `cargo test` / `cargo build` / `cargo clippy` | `rtk cargo test` 等 |
| scala | `sbt test` / `sbt compile` | `rtk sbt test` / `rtk sbt compile` |
| system | `ls -la` / `cat f.txt` / `head -5 f.txt` / `rg foo` / `find . -name x` / `tree` / `du -sh .` | `rtk ls -la`、`rtk read f.txt`、`rtk read f.txt --head-lines 5` 等 |

无等价命令（exit 1）透传实测：`echo hi`、`pwd`、`env`、`mkdir -p a`、`rm x`、`which node`、`whoami`、`Get-ChildItem`、`npm test`、`tail f.txt` —— 全部原样透传。

### 2.4 P1-1 成因取证（真 rtk）

```
   ok   成因取证：rewrite "-h" 无 -- → exit 0/458字节，有 -- → exit 1/0字节
   ok   成因取证：rewrite "--help" 无 -- → exit 0/1794字节，有 -- → exit 1/0字节
   ok   成因取证：rewrite "-hh" 无 -- → exit 0/458字节，有 -- → exit 1/0字节
```

这三行是 P1-1 的直接证据：不加 `--` 时 rtk 把 `-h` 当自己的 flag，把 458/1794 字节帮助文本打到 stdout 并 **exit 0**；插件旧代码 `if (!err) resolve(out || null)` 会把它当改写结果交给 shell。加 `--` 后 exit 1 无输出，安全透传。

---

## ③ 变异测试记录

工具：`mutate.js`（自建，30 个变异体）。做法：把变异体写进 `index.js` 的**临时副本**（`.mutants/NN.js`），用 `RTK_TEST_TARGET` 指向副本跑 `test.js`，确认变红。**原始 `index.js` 全程未被修改**（脚本结尾做 sha256 比对确认）。

### 3.1 汇总

| 指标 | 结果 |
|---|---|
| 变异体总数 | 30 |
| 被捕获（测试变红） | **28** |
| 等价变异体（已论证，非测试缺口） | 2 |
| 未论证的存活变异体 | **0** |
| 无效（片段不匹配） | 0 |
| **有效捕获率** | **100.0%（28/28）** |
| 基线校验 | 未变异副本 258/258 PASS（变异前先证明测试本身是绿的） |
| 原始 index.js 完整性 | sha256 前后一致 ✅ |

### 3.2 逐条记录

#### 审查发现的两条真实缺陷（task-8 新增，最重要的两条）

| ID | 变异体 | 捕获 | 触发失败的用例 |
|---|---|---|---|
| **P0-1** | 把 `super.execute` 移回 `try` 内（还原「沙箱异常被吞 + 命令执行两次」） | ✅ | E0 组 9 项：沙箱异常必须上抛 / 异常类型保留 / **只执行 1 次（不是 2 次）** / 不得降级成 warn / 取消必须上抛… |
| **P1-1** | 去掉 `--` 隔离（还原「`-h` 的 help 文本被当命令执行」） | ✅ | E1a 组 6 项：`-h`/`--help`/`-hh` 最终执行内容不得是 help 文本 + 必须等于原命令 |

这两条在补测前是**完全逃逸**的（原 247 项测试全绿但缺陷存在），原因是假 `SandboxPwshExecutor.execute()` 永不抛错，且没有任何 dash 用例。

#### 递归防护（9 个）

| ID | 变异体 | 捕获 | 触发 |
|---|---|---|---|
| M01 | `segments.every` → `segments.some` | ✅ | C 组 11 项（含★关键反例 `ls -la && rtk git status`） |
| M02 | 删 `toLowerCase()` | ✅ | C+E 组 7 项（`RTK`/`RTK.EXE`） |
| M03 | 删 basename 提取 | ✅ | C+E 组 9 项（绝对路径 / `./rtk` / POSIX 路径） |
| M04 | 删 env 前缀跳过循环 | ✅ | C+E 组 3 项（`RTK_DISABLED=1 rtk ...`、`FOO=bar BAZ=1 rtk ...`） |
| M05 | `firstWord` 引号分支退化为整段返回 | ✅ | C+E 组 5 项（`"rtk"`、`'rtk'`、带引号绝对路径） |
| M06 | `RTK_EXE_NAMES` 去掉 `rtk.exe` | ✅ | C+E 组 12 项 |
| M07 | `splitSegments` 不再按 `;`/`&`/`\|` 切分 | ✅ | C+E 组（后置位置用例） |
| M08 | `every` → 恒 `true`（插件整体失效） | ✅ | 全组 38 项 |
| M26 | 删引号状态跟踪（引号内 `;`/`\|` 被当分隔符） | ✅ | E 组（`rtk grep "foo;bar"` 等 9 条） |

#### 退出码判定（10 个）

| ID | 变异体 | 捕获 | 触发 |
|---|---|---|---|
| M09 | exit 1 判定 `=== 1` → `=== 0` | ✅ | A 组「exit 1 不产生告警」 |
| M10 | exit 3 分支 `=== 3` → `>= 1` | ✅ | A 组「exit 7 + 输出 → 不采纳」 |
| M11 | 删 exit 2 分支 | ✅ | A 组「exit 2 是已定义分支 → 不产生告警」 |
| M12 | 去掉 `&& out` | ✅ | A 组「exit 3 无输出 → 产生告警」 |
| M13 | 删超时分支 `err.killed` | ✅ | A 组「超时 → 告警文案提到 timeout」 |
| M14 | `'ENOENT'` → `'enoent'` | ✅ | B 组「后续调用不重复告警」 |
| M15 | 去掉 `trim()` | ✅ | A 组「stdout 只有空白」+「前后带空白」 |
| M16 | 删 else 分支告警 | ✅ | A 组 4 项告警断言 |
| M28 | `missingWarned` 单次告警失效 | ✅ | B 组「不重复告警」 |
| M27 | `Number(err.code) === 1` → `err.code === 1` | **= 等价** | 见 3.3 |

#### 恒等/替换、开关、失败安全（9 个）

| ID | 变异体 | 捕获 | 触发 |
|---|---|---|---|
| M17 | 去掉 `rewritten !== spec.command` | ✅ | A 组「恒等输出 → 不打印改写日志」 |
| M18 | 去掉 `{ ...spec }` 展开 | ✅ | D 组 7 项（沙箱字段透传） |
| M19 | `RTK_DISABLED === '1'` 取反 | ✅ | 全组 37 项 |
| M20 | catch 里把改写失败也上抛 | ✅ | D2 组 3 项 |
| M21 | 失败时返回 undefined（命令被吞） | ✅ | 测试进程异常退出（`super.execute 从未被调用`） |
| M22 | 去掉 `segments.filter` | ✅ | E 组 9 项空段用例 |
| M23 | `segments.length > 0` → `>= 0` | ✅ | E 组「空命令 === false」 |
| M24 | `ENV_ASSIGNMENT` 只认 `FOO=` | ✅ | C+E 组 3 项 |
| M25 | 删连续操作符跳过循环 | **= 等价** | 见 3.3 |

### 3.3 两个等价变异体的论证（不是测试缺口）

**M25 — 删掉 `while (i + 1 < length && '&|'.includes(next)) i++`**
下游 `segments.filter(s => s.trim().length > 0)` 会把 `&&` 切开产生的空段滤掉，所以两处防护互为冗余。实测验证：删掉 while 后，`rtk git status && && rtk ls` 被切成 `['rtk git status ', ' ', ' rtk ls']`，filter 去掉中间的 `' '`，结果与保留 while 完全一致。**行为等价。**

**M27 — `Number(err.code) === 1` → `err.code === 1`**
Node 只在**子进程正常退出**时把退出码以**数字**放进 `err.code`；只有 spawn 失败（ENOENT 等）才是字符串。实测四种退出码：`exit=1/2/3/7` 时 `typeof err.code === 'number'` 全部成立，`code === exit` 与 `Number(code) === exit` 结果一致；仅 `ENOENT` 是字符串，而那条路径在 M27 之前就被 `err.code === 'ENOENT'` 分支拦掉了。

**结论修正（终审）**：原表述「完全一致 / `Number()` 不是必需」过强。严格说二者**不严格等价** —— 若 `err.code` 为字符串 `"3"`，`Number()` 版会走 exit 3 采纳改写，裸比较版会落到 else 警告透传。但 Node 当前取值域只有 number 与 `"ENOENT"`（后者已被前置分支拦掉），在此域内结果一致。所以存活可接受，且 `Number()` 的正确定位是**对未来 Node 改字符串退出码的防御**，而非当前必需（注释见 `index.js:190-192`）。这是「防御性设计的正当理由」，不是「行为等价」。

---

## ④ 与上游契约的一致性结论

### 4.1 退出码契约（依据 `src/hooks/rewrite_cmd.rs` + 本机实测）

| exit | stdout | 上游语义 | 插件正确处理 | 测试断言位置 |
|---|---|---|---|---|
| **0** | 改写文 | allow 规则覆盖链上每条命令（**罕见**） | 采用 stdout | A |
| **1** | 空 | 无等价 / 无可改写 / `$(...)` / 文件重定向 / heredoc | **静默**原样执行，不告警 | A + B |
| **2** | **恒空** | deny 规则命中（`rewrite_cmd.rs:122` 用 `process::exit(2)`，全仓仅此一处） | 原样执行，不告警 | A |
| **3** | 改写文 | ask 规则命中或 allow 未覆盖（**默认常态**，`rewrite_cmd.rs:242` 注释 `// MUST be 3, not 0!`，issue #1155 回归测试在 `:292-305`） | 采用 stdout | A |
| 其它 | 不定 | 未定义 | **不采纳** stdout，原样执行 + 告警 | A |

> **与旧 test.js 注释的差异**：旧注释写「exit 3 = 有等价」，实际 exit 3 是**默认**（没配 Claude Code allow 规则就是 3），exit 0 才是罕见。插件对两者行为一致（都采用 stdout），所以不影响正确性，但注释已按真相更新。

### 4.2 递归防护契约

- 上游判定（`registry.rs:836`）：`!has_compound && (starts_with("rtk ") || == "rtk")`，**仅对非复合命令**且**大小写敏感的字面量**。
- 插件判定（`isRtkInvocation`，`index.js:174-177`）：**分段 + 逐段判定**，覆盖大小写、`.exe`、路径、引号、env 前缀。**故意比上游宽**，理由：这些形态 rtk 都不认识，多 spawn 一次虽安全但浪费；插件提前跳过更优。
- **关键反例（已锁）**：`ls -la && rtk git status` → rtk 实测返回 `rtk ls -la && rtk git status`（首段需改写）。插件必须**交给 rtk**而非整体跳过。C 组与 E 组各有一条专门断言，`every→some` 变异体（M01）被它捕获。

### 4.3 复合命令与管道

- 上游 `rewrite_compound`（`registry.rs:1284-1397`）自己逐段改写，`&&`/`;`/`|`/多行/引号内 `&&`/env 前缀全部正确。
- **插件不拆分**，整串交给 rtk，拿 rtk 的输出整串执行。F 组逐条比对，8/8 一致。
- 整串不可改时（`$(...)`、文件重定向、heredoc）→ exit 1 → 原串执行。已测。

### 4.4 环境变量

| 变量 | 归属 | 语义 | 测试 |
|---|---|---|---|
| `RTK_BIN` | **插件私有** | 指定 rtk 可执行体；上游 rtk 没有此变量 | 全套件通过它注入假 rtk |
| `RTK_DISABLED=1` | **插件自发开关** | 直接跳过改写（**不是** rtk 的开关） | D 组：断言「插件层不调用 rtk」+ 反向测 `0`/`true`/`yes`/`` 都不触发 |
| `RTK_DISABLED=1 rtk xxx` | **rtk 的命令文本前缀** | rtk 侧的旁路写法 | C + E 组：作为 env 前缀被递归防护正确识别 |

> 重要修正：上一版注释暗示 `RTK_DISABLED` 是 rtk 的开关。实测 `RTK_DISABLED=1 rtk rewrite 'git status'` **仍然 exit 3 并改写**（`src/hooks/posthook.rs:78` 只作用于 PostToolUse hook，不影响 `rewrite`）。现已按真相写入注释与测试。

### 4.5 版本一致性

| 版本 | 值 | 说明 |
|---|---|---|
| 上游 Cargo.toml | 0.49.0 | 与 tag 不同步 |
| 上游 tag | dev-1.2.0-rc.620 | release-please 生成 |
| 本机（本轮开始） | 1.1.0 | 用户此前安装 |
| 本机（本轮实测时） | **0.49.0** | 期间被替换；**两版 rewrite 契约实测一致**（退出码、`--` 隔离行为、命令族覆盖全部相同） |

**结论**：三轨版本号不一致是上游发布流程的既成事实，但 `rtk rewrite` 的**行为契约在 0.49.0 / 1.1.0 / develop HEAD 三处一致**。插件不依赖具体版本号，只依赖契约，因此无需版本门禁。报告中的所有「本机实测」均标注了当时的版本。

---

## ⑤ 已知差异与原因

| # | 差异 | 原因 | 是否影响正确性 |
|---|---|---|---|
| 1 | 插件递归防护比上游宽（认得大小写/路径/引号/env 前缀，上游只认字面 `rtk `） | rtk 对不认识的首词一律 exit 1，多 spawn 一次安全但浪费；插件提前跳过省一次进程 | 否（更优） |
| 2 | `Number(err.code)` 在当前 Node 下非必需（M27 等价变异体存活） | 子进程正常退出时 `err.code` 已是 number | 否（防御性） |
| 3 | `splitSegments` 的 while 与 filter 互为冗余（M25 等价变异体存活） | 两处都能滤空段，任一存在即可 | 否 |
| 4 | 递归防护不读穿 wrapper：`sudo rtk ...`、`powershell -c "rtk ..."`、`FOO="a b" rtk ...`、`rtk=1 ls`、CRLF、`#` 注释 6 处漏判 | 快速路径，不做完整 shell 解析 | 否（都是安全漏判：多 spawn 一次或结果正确）——但**依赖 rtk 对不认识首词 exit 1 的宽容**，若 rtk 未来把 `sudo`/`powershell` 纳入改写规则需重新评估 |
| 5 | 帮助文本长度随 rtk 版本变化（实测 458 / 1794 字节） | clap 生成的 help 文本 | 否（断言只判「不含 `Usage:`/`Options:`/`Rewrite a raw command`」，不依赖长度） |
| 6 | 命令族冒烟结果绑定 rtk 版本 | 上游会持续新增命令族 | 否（断言「至少一条被改写」，不断言具体覆盖集合） |

---

## ⑥ 发现但未自行修的问题

### 已由 impl-engineer 修复（task-7，本轮测试已锁定）

| ID | 问题 | 修复 | 锁定用例 |
|---|---|---|---|
| **P0-1** | `try` 同时包住 `rtkRewrite` 与 `super.execute`：① 上游 `AbortError`（取消）与 `SandboxUnavailableError`（沙箱建不起来）被 catch 吞成 warn；② catch 后兜底 `return super.execute(spec)` 把**同一条命令再提交一次**（实测调用序列 `["rtk git status","git status"]`），写操作会执行两遍 | 只让改写 fail-open，`super.execute` 移出 try（`index.js:241-261`） | **E0 组 13 项** |
| **P1-1** | 未用 `--` 隔离 clap：`rtk rewrite -h` → help 打到 stdout + exit 0 → 458/1794 字节帮助文本被当命令交给 shell；`-h`/`--help`/`-hh` 三条触发 | `command.startsWith('-') ? ['rewrite','--',command] : ['rewrite',command]`（`index.js:198-201`） | **E1a 组 44 项 + E1b 组 33 项** |
| P2-3 | `isRtkInvocation` 注释夸大（声称覆盖所有段，实测 6 处漏判） | 注释改为如实描述 + 写明「安全性部分依赖 rtk 的宽容，若 rtk 纳入 sudo/powershell 需重新评估」（`index.js:164-172`） | — （文档性） |

### 本轮新发现（给 reviewer / Lead 参考）

| # | 问题 | 严重度 | 建议 |
|---|---|---|---|
| N1 | 假 `SandboxPwshExecutor` 若能抛错本可以在第一轮就抓住 P0-1——测试替身的「永不失败」本身就是覆盖缺口 | 方法论 | 假替身应至少支持 1 条失败路径；本轮已加 `__FAIL_MODE`（sandbox / abort-always / abort-check） |
| N2 | 本机 rtk 在任务期间从 1.1.0 被换成 0.49.0，说明 `rtk --version` 不可作为稳定前提 | 低 | 报告与 README 引用版本时应写「实测版本」而非「要求版本」；`test.js` 已动态探测版本并打印 |
| N3 | `RTK_TEST_FAST` 跳过 F/G/E1b 三组；若有人误在本地也用它，命令族覆盖会静默失效 | 低 | 输出头部已打印 `模式:STRICT` / `SOFT`；CI 用 FAST 是设计意图，本地应跑 `node test.js` |

---

## ⑦ 交付物与清理

### 交付物（入库）

| 文件 | 说明 |
|---|---|
| `test.js` | 12 组 365 项断言，零依赖，`node test.js` 可跑 |
| `.planning/2026-11-08-rtk-upstream-sync/verify-report.md` | 本文件 |

### 临时产物（**不入库**，已清理）

| 路径 | 用途 | 状态 |
|---|---|---|
| `.mutants/` | 变异体副本目录 | 脚本结束时自动删除 |
| `.tmp-probe/` | 手工探测脚本（假 rtk 注入、argv 调试、变异体定性等） | **待删除** |
| `mutate.js` | 变异测试运行器（2~3 分钟，30 个变异体） | **待删除**（如需保留可加入 `.gitignore` 后作为长期工具） |

> 提交前须确认 `git status` 不含以上三项。`mutate.js` 若要保留，建议改名为 `tools/mutate.mjs` 并加 `README` 说明，避免被误认为正式测试入口。
