# DSH 0.2.1-rc.3 适配验证报告

- 验证人：verifier（teammate）
- 验证时间：2026-10-24 15:27–15:33（Asia/Shanghai）
- 工作目录：`E:\Code\dsh\Rtk\.agents\worktrees\fix\dsh-0.2.1-rc.3-adapt`
- 被测对象：`dsh-pwsh-rtk-rewrite@1.1.6`（未发布，本地 worktree 打 tgz）
- 目标内核：DSH `0.2.1-rc.3`（`E:\Tool\DSH`）

## 0. 结论摘要

| 验证项 | 结论 | 关键证据 |
| --- | --- | --- |
| 1. `node test.js` 自检 | **通过** | 8 条 `ok` + 1 条 `skip` + `ALL PASS`，退出码 0 |
| 2. `npm pack --dry-run` 清单与版本 | **通过**（一处需说明，见 §2） | 版本 1.1.6；files 声明的 4 个文件全在；实际 6 个文件 |
| 3. 隔离 profile 安装（无 incompatible 告警） | **通过** | `add` 退出码 0，输出无任何告警；`plugin list` 显示 `1.1.6` |
| 4. 插件 patch 行被合并生效 | **通过** | `--dump-config` 出现 `patched by dsh-pwsh-rtk-rewrite`、`pwsh-sandbox: disabled: true`、新增 `rtk-pwsh-shell` |
| 5. bundle 未被兼容检查跳过 | **通过** | `loadProfileDirectory` → `skippedBundles: []`，layers 含本插件 |
| 6. 真实兼容判定函数 | **通过** | `evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.3')` → `undefined`（兼容）；负例被正确拒绝 |
| 7. 运行时解析内核 sandbox 包 | **通过** | Electron node 内 import 成功，`extends SandboxPwshExecutor`，`prototype chain matches: true` |
| 8. 端到端真实命令改写（临时 profile 内真正 boot） | **未验证** | 见 §7 原因；改写逻辑本身由 `test.js` 真实调用 `rtk` 二进制覆盖 |
| 9. 桌面端 desktop profile 换成 1.1.6 | **未执行（按约束禁止）** | 仅只读参考，未做任何写入 |

**总体判断：1.1.6 在 DSH 0.2.1-rc.3 上的打包、安装、兼容判定与加载链路全部实测通过，未发现阻塞问题。**

---

## 1. 验证项一：`node test.js`

命令（在 worktree 根目录）：

```bash
node test.js; echo "EXIT_CODE=$?"
```

真实输出（逐字）：

```
ok: git status -> rtk git status
ok: Get-ChildItem -> null (exit 1)
ok: rtk git status -> identity
ok: index.js default export is a class
ok: desktop layout candidate contains resources/app.asar/dsh
skip: real desktop asar check needs the Electron main process (bare node cannot read asar)
ok: peer range covers kernel 0.2.1-rc.3 under includePrerelease
ok: peer range needs includePrerelease for 0.2.1-rc.3 (default semver would miss it)
ALL PASS
EXIT_CODE=0
```

结论：**通过**。

- 8 条断言通过，退出码 0。
- 前 3 条是真实调用本机 `rtk rewrite` 二进制的行为断言（含"有等价 / 无等价 / 已是 rtk 形式"三种分支），非纯逻辑模拟。
- 1 条 `skip` 是预期设计：asar 内文件只有 Electron 主进程（fs 已 patch）能读，裸 `node`（`E:\Tool\nodejs\node.exe`）读不到，测试已自动降级为跳过而非失败。
- 新增的第 6、7 条断言用 `test.js` 内置的最小 semver 实现验证 peer 范围；本次另用**真实 semver 7.8.5** 交叉复核（见 §5.3），两者结论一致，且"默认语义会漏判"的反向断言也成立。

---

## 2. 验证项二：`npm pack --dry-run`

命令：

```bash
npm pack --dry-run
```

真实输出（逐字）：

```
npm notice package: dsh-pwsh-rtk-rewrite@1.1.6
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 12.0kB README_zh.md
npm notice 13.1kB README.md
npm notice 691B cordis.patch.yml
npm notice 7.3kB index.js
npm notice 1.1kB package.json
npm notice Tarball Details
npm notice name: dsh-pwsh-rtk-rewrite
npm notice version: 1.1.6
npm notice filename: dsh-pwsh-rtk-rewrite-1.1.6.tgz
npm notice package size: 13.8 kB
npm notice unpacked size: 35.4 kB
npm notice shasum: e1611ab48ff7c7edc93c87a05dbc2300d3b36151
npm notice integrity: sha512-LmxCH8wu4VkeV[...]P4JDfzY/7CRUQ==
npm notice total files: 6
```

结论：**通过**。

- 版本号 = **1.1.6**，tarball 名 = `dsh-pwsh-rtk-rewrite-1.1.6.tgz`。
- `package.json` 的 `files` 声明 4 项（`index.js`、`cordis.patch.yml`、`README.md`、`README_zh.md`）**全部包含**。
- **需说明的偏差**：实际打包 6 个文件，多出 `package.json` 与 `LICENSE`。这是 npm 的固有行为——`package.json`、`README*`、`LICENSE*` 属"始终包含"文件，`files` 字段无法排除它们。**不是配置缺陷**，无需修改。
- 无 `node_modules/`、无 `test.js`、无 `.planning/`、无 `.github/` 泄漏。
- 真实 `npm pack` 产出的 tgz 为 13,788 字节，shasum 与 dry-run 一致（`e1611ab4…`），说明 dry-run 与真实打包清单等价。

---

## 3. 验证项三：隔离 profile 安装冒烟（关键项）

### 3.1 CLI 能力确认

命令：

```bash
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" plugin --help
```

真实输出：

```
Usage: dsh plugin [options] [args...]

manage a profile's plugins by forwarding the remaining arguments to pnpm in the
profile directory

Arguments:
  args              pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>,
                    why <pkg>, ...)

Options:
  --profile <name>  the profile whose plugins to manage (initialized on first
                    use)
```

结论：CLI 支持 `--profile <name>` 按**名字**管理 `~/.dsh/profiles/<name>`，首次使用自动初始化，因此可安全隔离验证。**无** `--profile <路径>` 形式，也**无** `DSH_PROFILE_DIR` 环境变量；但按名字建临时 profile 已满足隔离要求。

另注：`plugin` 子命令是"**verbatim 转发给 pnpm**"，本身不做兼容性检查——因此"add 无告警"不能单独作为兼容证据，真正的兼容判定在加载阶段（§4、§5 已补证）。

`dsh.cmd` 实质是：

```cmd
set "ELECTRON_RUN_AS_NODE=1"
"...\DeepSeek Harness.exe" --expose-internals "...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

### 3.2 安装命令与输出（临时 profile）

前置确认：`~/.dsh/profiles/` 原本仅有 `desktop`、`web`，`tmp-rtk-rc3-verify` 不存在。

```bash
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" plugin --profile tmp-rtk-rc3-verify \
  add "E:/Code/dsh/Rtk/.agents/worktrees/fix/dsh-0.2.1-rc.3-adapt/dsh-pwsh-rtk-rewrite-1.1.6.tgz" \
  --registry=https://registry.npmjs.org/
```

真实输出（逐字）：

```
dsh: initialized profile tmp-rtk-rc3-verify at C:\Users\ASUS\.dsh\profiles\tmp-rtk-rc3-verify
Progress: resolved 0, reused 1, downloaded 0, added 0
Packages: +1
+
Packages are hard linked from the content-addressable store to the virtual store.
  Content-addressable store is at: C:\Users\ASUS\AppData\Local\pnpm\store\v11
  Virtual store is at:             node_modules/.pnpm
Progress: resolved 1, reused 1, downloaded 1, done

dependencies:
+ dsh-pwsh-rtk-rewrite 1.1.6

Done in 823ms using pnpm v11.28.5
Update available! 11.28.5 → 12.15.0.
```

退出码：`0`。

结论：**通过**。全程**未出现** `incompatible with dsh 0.2.1-rc.3` 或任何 peer 相关告警（输出中仅有 pnpm 自身进度与 pnpm 版本更新提示，与本插件无关）。

### 3.3 临时 profile 文件落位检查

`~/.dsh/profiles/tmp-rtk-rc3-verify/` 实际内容：`.plugin-manager/`、`cordis.patch.yml`、`node_modules/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。

`package.json`（逐字）：

```json
{
  "name": "dsh-profile-tmp-rtk-rc3-verify",
  "private": true,
  "dependencies": {
    "dsh-pwsh-rtk-rewrite": "file:E:/Code/dsh/Rtk/.agents/worktrees/fix/dsh-0.2.1-rc.3-adapt/dsh-pwsh-rtk-rewrite-1.1.6.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-pwsh-rtk-rewrite"
      ]
    }
  }
}
```

关键点：
- 依赖已登记为 `1.1.6` 的 tgz。
- **`dsh.profile.bundles` 自动加入了 `dsh-pwsh-rtk-rewrite`** —— 插件行被注册进 profile 的 bundle 栈，这是"插件行生效"的第一层证据（无需手工编辑）。

`cordis.patch.yml` 为 profile 用户层，内容为 `[]`（空数组，符合新初始化骨架）。插件自带的 patch 不在 profile 目录，而在 `node_modules/dsh-pwsh-rtk-rewrite/cordis.patch.yml`，经插件 `package.json` 的 `dsh.bundle.patch: "./cordis.patch.yml"` 声明，由 DSH 在合成时合并（见 §4）。

`cordis.yml`：**未生成**。这是运行时产物（`desktop` profile 有是因为启动过），未 boot 的 profile 不产生该文件，因此不能作为检查对象——改用 `--dump-config` 与 `loadProfileDirectory` 达到同等目的（§4、§5）。

`node_modules/dsh-pwsh-rtk-rewrite/` 解包内容 = tgz 内容 6 个文件；其 `package.json`：

```
version = 1.1.6
dsh = {"bundle":{"patch":"./cordis.patch.yml"}}
peerDependencies = {"@deepseek-ai/dsh-pwsh-sandbox":">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || 0.1.7-rc.2 || >=0.2.0-rc.1 <0.3.0-0"}
```

`.plugin-manager/logs/operation-bSuufU/pnpm.log` 为空文件。

### 3.4 `plugin list`

```bash
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" plugin --profile tmp-rtk-rc3-verify list
```

真实输出：

```
Legend: production dependency, optional only, dev only

dsh-profile-tmp-rtk-rc3-verify C:\Users\ASUS\.dsh\profiles\tmp-rtk-rc3-verify (PRIVATE)
│
│   dependencies:
└── dsh-pwsh-rtk-rewrite@1.1.6

1 package
```

退出码 0。结论：**通过**。

---

## 4. 验证项四：patch 合并结果（`--dump-config`）

```bash
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" --profile tmp-rtk-rc3-verify --dump-config \
  > /tmp/dump-config.out 2>/tmp/dump-config.err
```

- 退出码：`0`
- stderr：**空**
- stdout：367 行

层注释（`grep -n "^# =="`）：

```
1:# == @deepseek-ai/dsh-base
143:# == @deepseek-ai/dsh-base, patched by dsh-pwsh-rtk-rewrite
147:# == @deepseek-ai/dsh-base
363:# == dsh-pwsh-rtk-rewrite
```

关键片段：

```yaml
# == @deepseek-ai/dsh-base, patched by dsh-pwsh-rtk-rewrite
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: true
```

```yaml
# == dsh-pwsh-rtk-rewrite
- id: rtk-pwsh-shell
  name: dsh-pwsh-rtk-rewrite
  config: {}
  disabled: !!js process.platform !== 'win32'
```

结论：**通过**。插件 patch 被真实加载并作用于内核 bundle：
1. 原有 `pwsh-sandbox` 行被 **禁用**（`disabled: true`，避免两个 `ctx.shell` 并存）；
2. 新增 `rtk-pwsh-shell` 行，指向本插件，平台守卫保留（非 win32 禁用）。

> 注：首次执行时我用 `... | tee file | head -40` 读输出，`head` 提前退出触发 SIGPIPE 导致落盘文件被截断（仅 135 行、缺插件层）。已去掉 `head` 重跑，上表结论基于完整 367 行输出。

---

## 5. 验证项五：bundle 未被兼容检查跳过 + 真实判定函数

### 5.1 定位真实判定实现

在 Electron 运行时内只读检查 asar：

- 内核包：`E:\Tool\DSH\resources\app.asar\dsh\package.json` → `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.3**
- 判定实现：`...\app.asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`（`dsh-app-boot` 版本 **0.2.1-rc.3**）

判定语义（源码摘录）：

```js
// 276-278
function satisfies(runtimeVersion, range) {
	return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
}
// 1015-1026（loadProfileDirectory）
const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
// 333-335（告警文本）
return `Plugin ${key} is incompatible with dsh ${issue.runtimeVersion}: requirements ... Running it may cause crashes or data loss. ...`;
```

而该 `throw` 被 1015–1040 的 `try/catch` 捕获并归入 `skippedBundles`（"**skipped without changing the manifest and listed in `skippedBundles`; nothing is printed**"）——这解释了为什么不兼容不会在 `add` 时喊出来，而会在加载期静默跳过。因此必须直接检查 `skippedBundles`（见 5.2）。

### 5.2 实际加载：`loadProfileDirectory`

在 Electron（`ELECTRON_RUN_AS_NODE=1`）内调用真实模块：

```
profile name   = tmp-rtk-rc3-verify
layers         = [ '@deepseek-ai/dsh-base', 'dsh-pwsh-rtk-rewrite' ]
skippedBundles = []
user patchPath = C:\Users\ASUS\.dsh\profiles\tmp-rtk-rc3-verify\cordis.patch.yml | user patches count = 0
  layer @deepseek-ai/dsh-base: patchPaths=[...app.asar\dsh\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml] patches=1
  layer dsh-pwsh-rtk-rewrite: patchPaths=[...\tmp-rtk-rc3-verify\node_modules\dsh-pwsh-rtk-rewrite\cordis.patch.yml] patches=2
    patches = [{"id":"pwsh-sandbox","disabled":true},
               {"insert":[{"id":"rtk-pwsh-shell","name":"dsh-pwsh-rtk-rewrite","config":{},"disabled":{"__jsExpr":"process.platform !== 'win32'"}}]}]
```

合成结果（`composeEntries`）：

```json
[
  { "id": "pwsh-sandbox", "name": "@deepseek-ai/dsh-pwsh-sandbox", "disabled": true },
  { "id": "rtk-pwsh-shell", "name": "dsh-pwsh-rtk-rewrite", "config": {},
    "disabled": { "__jsExpr": "process.platform !== 'win32'" } }
]
```

结论：**通过**。`skippedBundles` 为空 → 兼容检查未拒绝该 bundle；插件 patch 从 tgz 解包目录读出 2 条，与源文件逐字对应。

### 5.3 真实判定函数 + 真实 semver 复核

```
app-boot version = 0.2.1-rc.3
semver version   = 7.8.5
plugin: dsh-pwsh-rtk-rewrite@1.1.6
peerRange = >=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || 0.1.7-rc.2 || >=0.2.0-rc.1 <0.3.0-0
satisfies(includePrerelease:true) = true
satisfies(default)                = false
sandbox 0.2.1-rc.3 vs range       = true
evaluatePluginCompatibility(pluginManifest, {}, '0.2.1-rc.3') -> undefined (compatible)
```

**负例校验**（把 peer 范围改成 `>=0.2.0-rc.1 <0.2.1-0`，仅在内存中构造，未改文件）：

```
mutated issue = rejected as expected
mutated warning head = Plugin dsh-pwsh-rtk-rewrite@1.1.6 is incompatible with dsh 0.2.1-rc.3: requirements {"@deepseek-ai/dsh-pwsh-sandbox":">=0.2.0-rc.1 <0.2.1-0"}. Running it may ca...
```

结论：**通过**。
- 用 DSH 自己的真实判定函数 + 真实 `semver@7.8.5` 得到"兼容"，不依赖 `test.js` 里的最小实现。
- 负例证明判定不是恒真：范围一旦不覆盖 rc.3，函数立即产出 issue 并生成 incompatible 告警文本。
- 同时确认 **`includePrerelease: true` 是必需的**：默认语义下 `0.2.1-rc.3` 会被判为不满足（`false`）。这与 `test.js` 第 7 条反向断言一致，也说明 peerDependencies **无需**为 rc.3 再加分支（现有 `>=0.2.0-rc.1 <0.3.0-0` 已覆盖，保持最小 diff 正确）。

---

## 6. 验证项六：运行时能否解析到内核 sandbox 包

裸 `node` 读不到 asar（`existsSync = false`，`readFileSync ENOENT`，实测确认），因此改用 **Electron 自身的 node 运行时**（`ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe"`）——这与插件真实运行进程（Electron 主进程，fs 已 patch）一致。

探测结果：

```
=== 裸 node ===
execPath = E:\Tool\nodejs\node.exe
existsSync(asar) = false
readFileSync FAILED: ENOENT

=== Electron (ELECTRON_RUN_AS_NODE=1) ===
execPath = E:\Tool\DSH\DeepSeek Harness.exe
electron-like = true
existsSync(asar) = true
readFileSync OK, name = @deepseek-ai/dsh-desktop-runtime version = 0.2.1-rc.3
```

加载链验证（设 `DSH_INSTALL_PACKAGE_JSON` 指向内核 package.json，动态 import 临时 profile 内的插件 `index.js`）：

```
[A] kernel package: @deepseek-ai/dsh-desktop-runtime 0.2.1-rc.3
[B] sandbox package.json exists: true
[B] sandbox package: @deepseek-ai/dsh-pwsh-sandbox 0.2.1-rc.3 main: lib/index.js
[C] plugin default export: function
[C] extends class: SandboxPwshExecutor
[C] grandparent prototype: PwshLocalExecutor
[D] resolved sandbox from kernel: E:\Tool\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-pwsh-sandbox\package.json
[D] SandboxPwshExecutor is class: true
[D] prototype chain matches: true
```

结论：**通过**。
- 桌面端内核实际装配的 `@deepseek-ai/dsh-pwsh-sandbox` 版本 = **0.2.1-rc.3**（与 adapter 的 devDependency 对齐）。
- 插件 `index.js` 顶层 `createRequire(resolveDshPackageJson())(CORE_PACKAGE)` 解析成功，导出的默认类是 class，且 `Object.getPrototypeOf(RtkPwshExecutor) === SandboxPwshExecutor`（**同一份**类实例，非同名重复类）——说明继承链真实打通，`super.execute()` 调用的是内核那份实现。
- 父类是 `PwshLocalExecutor`，与 index.js 注释所述的管线结构一致。

---

## 7. 未验证项与原因（如实记录）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 在临时 profile 内真正 boot 并触发一次 shell 命令，观察 `[rtk-rewrite] ... -> ...` 日志 | **未验证** | 临时 profile 仅有 `@deepseek-ai/dsh-base` + 本插件，无模型/会话/交互配置；`dsh --profile <name>` 会启动完整 Electron app（GUI），不适合做无人值守冒烟。改写逻辑本身已由 `test.js` 用真实 `rtk` 二进制覆盖（含三种分支）。 |
| 桌面端 desktop profile 安装/启用 1.1.6 | **未执行** | 任务与全局约束明确禁止对真实 desktop profile 做安装/卸载/升级。desktop 现状仍为 `1.1.5`，未受影响（只读查看过）。 |
| 跨平台（bash 宿主）行为 | **未验证** | 本机为 Windows，`disabled: !!js process.platform !== 'win32'` 的 bash 分支无法实机验证；与 1.1.5 该行逐字相同（§8），风险不变。 |
| 插件在插件市场（market）端的展示/安装路径 | **未验证** | 不属本次任务范围，未触及 market 组件。 |

---

## 8. 与桌面端运行中 1.1.5 的字节对比（附加佐证）

桌面端 `~/.dsh/profiles/desktop/node_modules/dsh-pwsh-rtk-rewrite/` 仍为 **1.1.5**（只读检查）。

| 文件 | git 存储版（HEAD，LF）sha256 | 工作区（CRLF）sha256 | desktop 1.1.5 sha256 |
| --- | --- | --- | --- |
| `index.js` | `b6a8610b80c5bad303a4ff764762f574e344e4c6eb3cb8dac98cccae6a644686` | `b10567fa14ab01f8e7975e08beee78daf71b47aaa15f7140851c8d3e373064f9` | `b6a8610b80c5bad303a4ff764762f574e344e4c6eb3cb8dac98cccae6a644686` |
| `cordis.patch.yml` | `83eee33f86c6237427e70ad9e7d0ef8ee780fdf2c40eb6f945a054dfbac85d1a` | `1c88c0170154944a7d3ece6ada33fcbced321da2391fb8b88b86130d84f04523` | `83eee33f86c6237427e70ad9e7d0ef8ee780fdf2c40eb6f945a054dfbac85d1a` |

- `diff` 显示"每一行都不同"，但 `diff --strip-trailing-cr` 结果为**完全一致** → 差异纯粹是行尾符。
- 原因：`git config core.autocrlf = true`，且仓库**无** `.gitattributes`，工作区 checkout 为 CRLF。
- **结论：1.1.6 的运行时文件（index.js、cordis.patch.yml）与桌面端正在运行的 1.1.5 在 git 存储层字节完全相同**，行为无差异，本次适配确属"零代码改动"。
- 附带观察（非阻塞）：`npm pack` 打包的是工作区文件，故发布产物将是 CRLF 版本；JS/YAML 均兼容 CRLF，不影响功能。若希望发布产物与仓库存储严格一致，可后续加 `.gitattributes`（`*.js text eol=lf` 等），**本次不做**（超出最小改动范围）。

---

## 9. 清理确认

| 对象 | 操作 | 状态 |
| --- | --- | --- |
| `C:\Users\ASUS\.dsh\profiles\tmp-rtk-rc3-verify`（含 node_modules、pnpm-lock） | `rm -rf` | 已删除 |
| `dsh-pwsh-rtk-rewrite-1.1.6.tgz`（worktree 内） | `rm -f` | 已删除 |
| 临时探测脚本（7 个，位于 `%LOCALAPPDATA%\Temp`） | `rm -f` | 已删除 |

清理后 `~/.dsh/profiles/` 仅剩 `desktop`、`web`（与验证前一致）；worktree 无 `*.tgz` 残留。

仓库状态（确认未被验证过程改动，仅 adapter/docs 的既有修改）：

```
 M README.md
 M README_zh.md
 M package-lock.json
 M package.json
 M test.js
```

本报告是本任务**唯一**新增文件，未 `git commit`。

---

## 10. 风险与建议

**残留风险**

1. **发布产物行尾为 CRLF**（§8）。功能无影响，但与 1.1.5 的发布包在字节层不完全可比；若将来有人用校验和对齐版本，可能出现"疑似不一致"的误判。
2. **端到端未实测**（§7）：插件被加载、patch 合并、类可实例化均已验证，但"真实命令经 rtk 改写后执行"发生在 desktop profile（当前 1.1.5），1.1.6 的这条路径未在实机走通。考虑到 1.1.6 与 1.1.5 运行时字节相同（§8），风险极低。
3. **兼容性失败是静默跳过**：若未来 peer 范围失配，`add` 不会报错，只在加载期进 `skippedBundles`（不打印）。排查此类问题时需显式检查 `skippedBundles` 或 `--dump-config` 中是否缺少插件层。

**建议**

1. 按现有 `package.json`（1.1.6）发布即可，无需改代码。
2. 桌面端升级时，建议发布后执行：`dsh.cmd plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.1.6 --registry=https://registry.npmjs.org/`（钉精确版本），随后 `--dump-config` 确认仍出现 `patched by dsh-pwsh-rtk-rewrite` 与 `rtk-pwsh-shell`。
3. 可选后续项（不在本次范围）：新增 `.gitattributes` 固定 LF。

---

## 附：完整命令清单

```bash
# 1) 自检
node test.js; echo "EXIT_CODE=$?"

# 2) 打包检查
npm pack --dry-run
npm pack

# 3) CLI 能力
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" plugin --help
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" --help

# 4) 隔离 profile 安装
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" plugin --profile tmp-rtk-rc3-verify \
  add "E:/Code/dsh/Rtk/.agents/worktrees/fix/dsh-0.2.1-rc.3-adapt/dsh-pwsh-rtk-rewrite-1.1.6.tgz" \
  --registry=https://registry.npmjs.org/
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" plugin --profile tmp-rtk-rc3-verify list

# 5) patch 合并
"E:/Tool/DSH/resources/runtime/cli/bin/dsh.cmd" --profile tmp-rtk-rc3-verify --dump-config \
  > /tmp/dump-config.out 2>/tmp/dump-config.err

# 6) 真实判定函数 / loadProfileDirectory / 运行时解析（Electron node 内执行探测脚本）
ELECTRON_RUN_AS_NODE=1 "E:/Tool/DSH/DeepSeek Harness.exe" <probe>.mjs

# 7) 与 desktop 1.1.5 对比
sha256sum ~/.dsh/profiles/desktop/node_modules/dsh-pwsh-rtk-rewrite/index.js
diff --strip-trailing-cr ~/.dsh/profiles/desktop/node_modules/dsh-pwsh-rtk-rewrite/index.js index.js

# 8) 清理
rm -rf "C:/Users/ASUS/.dsh/profiles/tmp-rtk-rc3-verify"
rm -f "E:/Code/dsh/Rtk/.agents/worktrees/fix/dsh-0.2.1-rc.3-adapt/dsh-pwsh-rtk-rewrite-1.1.6.tgz"
```
