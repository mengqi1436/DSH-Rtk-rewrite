# 上游侦查报告：dsh-v0.2.1-rc.2 → dsh-v0.2.1-rc.3 对本插件的契约影响

- 侦查人：upstream-scout（只读侦查，未改任何源码，未做任何 profile 安装/卸载）
- 时间：2026-10-24
- 上游仓库：https://github.com/deepseek-ai/deepseek-harness
- 对比对象：tag `dsh-v0.2.1-rc.2`（687f282e8…）→ tag `dsh-v0.2.1-rc.3`（1f81c047f…）
- 标注约定：**[亲验]** = 本次侦查自己执行命令得到；**[采信]** = 采信 lead 转述的 teammate（docs-writer / verifier）已核实结论；**[推断]** = 由证据推导但未直接执行验证；**无法验证** = 明确未能取证。

---

## 0. 结论（先给答案）

**本插件（`dsh-pwsh-rtk-rewrite`：继承 `SandboxPwshExecutor`、覆写 `execute(spec)` 改写 `spec.command`、用 `cordis.patch.yml` 的 id-target `disabled` + `insert` 挂载）在 dsh 0.2.1-rc.3 上不需要任何代码、清单或补丁文法改动。** 需要改的只有版本对齐类元数据（devDependency 钉版本、自身 version 升级），不涉及契约。

逐条对照本插件的四个契约面：

| 契约面 | 本插件依赖点 | rc.3 是否变化 | 判定依据 |
| --- | --- | --- | --- |
| 1. `@deepseek-ai/dsh-pwsh-sandbox` 的 `SandboxPwshExecutor` 与 `execute(spec)`/`spec.command` | `index.js:135-155` `extends SandboxPwshExecutor`、`spec.command` 改写、`{...spec, command}` 回传 | **未变** | 该包 `lib/index.js` 两版本字节相同（SHA256 `bed19d2c…`）；`lib/types/**`、`locale/**` 亦完全相同，仅 `package.json` 版本与内部依赖 pin 变动 [亲验] |
| 2. `ctx.shell` 单一实现约束与 base 行 id `pwsh-sandbox` | 补丁首行 `- id: pwsh-sandbox / disabled: true` | **未变** | `packages/bundle/base/cordis.patch.yml` 两 tag 同一 blob `7d63cf26…`，其中 `- id: pwsh-sandbox` 仍在第 255 行 [亲验] |
| 3. 补丁文法（id-target disable、`insert:`、`!!js` 表达式） | `cordis.patch.yml` 全文 | **未变** | patch 实现在 `packages/boot/app-boot/src`（整目录两 tag 同一 tree `14016c95…`）与 `packages/boot/plugin-manager`、`packages/boot/config-editor`（两 tag 仅 `package.json` 变动）[亲验] |
| 4. 插件兼容判定语义 `evaluatePluginCompatibility` | `peerDependencies['@deepseek-ai/dsh-pwsh-sandbox']` | **未变** | `packages/boot/app-boot/src/plugin-compatibility.ts` 两 tag 同一 blob `2e4ca573…`；判定用 `semver.satisfies(v, range, {includePrerelease:true})`，现有 range 实测覆盖 0.2.1-rc.3 [亲验] |

---

## 1. 取证方法（含失败记录，不重试已证实不可行的路径）

1. `git clone --filter=blob:none --no-checkout …` 到 `/tmp/dsh-upstream`：**失败**，300s 超时（无输出、`.git` 仅 61K）。原因：未加 `--depth` 时需要协商/下载全部历史树，本机到 GitHub 吞吐约 30 KB/s，不可行。**已按 lead 指示放弃该路径，不再重试。**
2. GitHub compare API（`api.github.com/repos/.../compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3`，curl）：可用，返回 6 个提交；但 `files` 被硬截断在 300 条，不能作为全量证据。
3. **最终采用的完整取证方式**：`git clone --depth 1 --single-branch --branch dsh-v0.2.1-rc.3 --filter=blob:none --no-checkout`（15.5s、781K）→ 在同一仓库 `git fetch --depth 1 origin refs/tags/dsh-v0.2.1-rc.2:refs/tags/dsh-v0.2.1-rc.2`（3.7s）→ `git diff-tree -r --name-status` / `git diff -- <path>` / `git ls-tree`。按需拉取 blob，全部结论可复核。
4. raw 直链交叉验证：`raw.githubusercontent.com/.../dsh-v0.2.1-rc.{2,3}/packages/boot/app-boot/src/plugin-compatibility.ts`，两文件均 HTTP 200、6093 字节，`diff` 无输出。
5. 桌面端 asar：`app.asar` 头部即标准 asar 头（payloadSize=4743488、jsonSize=4743484），但手写 header 解析脚本在 JSON.parse 处报错（未能定位原因，未深究）；改用 **Electron 以 Node 模式执行**（`ELECTRON_RUN_AS_NODE=1 "E:/Tool/DSH/DeepSeek Harness.exe" script.js`，Electron 44.7.0 / Node 24.21.0），借助 Electron 的 asar fs 补丁直接读取包内文件并算 SHA256，成功。
6. semver 判定：`npm pack semver@7.7.3` 离线解压后实测（不引入依赖到本仓库）。

---

## 2. 上游 rc.2 → rc.3 的实际变更范围

- 提交数 6（compare API）：导航入口定制、导航埋点、pin 与菜单图标分离、DeepSeek API-key 路由改用官方 `/models` 列表、`release(dsh): 0.2.1-rc.3`、release 分支合并。全部为 **client/UI/analytics/llm 侧**功能，无 shell/sandbox/boot 语义改动 [亲验]。
- tree 条目数：rc.2 = 16297、rc.3 = 16347 个**文件**条目（`git ls-tree -r --name-only | wc -l`；含目录的条目数口径不同，故与 teammate 报的 18758/18815 数值不同，但差量一致）[亲验]。
- `git diff-tree -r --name-status` 共 **646** 条变更记录（compare API 只给到 300，故必须以本地浅仓库为准）[亲验]。
- 按目录聚合前几名：`packages/client` 182、`snapshots` 71、`packages/llm` 48、`packages/experimental` 47、`apps/web` 26、`packages/session` 21、`packages/util` 18。

### 2.1 本插件关心的目录：逐个确认

**`packages/shell/**`（10 个变更，全部只是 `package.json`，`git diff -- packages/shell` 全文只有 `- "version": "0.2.1-rc.2"` / `+ "version": "0.2.1-rc.3"` 一行差异）**[亲验]：

```
M packages/shell/bash-local/package.json          M packages/shell/shell-env/package.json
M packages/shell/bash-sandbox/package.json        M packages/shell/shell/package.json
M packages/shell/pwsh-local/package.json          M packages/shell/tool-bash-persistent/package.json
M packages/shell/pwsh-sandbox/package.json        M packages/shell/tool-bash/package.json
M packages/shell/tool-pwsh-persistent/package.json  M packages/shell/tool-pwsh/package.json
```

`packages/shell/pwsh-sandbox/src/**`、`packages/shell/shell/src/**`、`packages/shell/pwsh-local/src/**` **无任何变更** —— 与 npm 包字节级一致的结论互为印证。

**`packages/sandbox/**`（4 个变更，同样只有 `package.json`）**：`sandbox-local`、`sandbox-policy`、`sandbox-windows-acl`、`sandbox` [亲验]。

**`packages/boot/**`（6 个变更，全部只有 `package.json`）**：`app-boot`、`cmdline`、`config-editor`、`hmr`、`plugin-manager`、`plugin-market` [亲验]。**`plugin-manager` / `plugin-market` / `config-editor` 的 `src/**` 一行未动**，故插件安装、市场、profile 补丁持久化的实现无变化。

**`packages/bundle/**`（7 个变更）**：`base`、`headless`、`sdk-app`、`sdk-minimal`、`acp-app`、`web-app` 的 `package.json` + **`web-app/cordis.patch.yml` 新增一条 UI 行**（`- id: entry-customization / name: '@deepseek-ai/dsh-client-ui-entry-customization'`，注释说明为 More 菜单的插件入口定制）[亲验]。`packages/bundle/base/cordis.patch.yml`（本插件 id-target 的宿主文件）**未变**。

**非 client 的源码变更全量清单**（`grep -v packages/client|experimental|llm` 后）只有：`apps/web/tests/**`、`apps/cli/tests/**`、`packages/api/session-controller/src/client/sessions/service.ts`（1 行）、`packages/extensions/cordis-client-runner/src/client/{api-catalog,slot-catalog}.ts`、`packages/extensions/tool-cordis/src/api-catalog.ts`、`packages/preset/agent-preset/skills/.../packages.md`、`packages/sdk/server/tests/server.spec.ts`，以及上面已列的 `web-app/cordis.patch.yml` [亲验]。**没有一处触及 shell/sandbox/executor/patch 解析语义。**

---

## 3. 核心问题 A：`plugin-compatibility.ts` 在 rc.2/rc.3 是否同一 blob

**是，同一 blob。**[亲验]

```
$ git ls-tree dsh-v0.2.1-rc.2 -- packages/boot/app-boot/src/plugin-compatibility.ts
100644 blob 2e4ca5736a775aceadb0a2a10140af61f94ed2ac
$ git ls-tree dsh-v0.2.1-rc.3 -- packages/boot/app-boot/src/plugin-compatibility.ts
100644 blob 2e4ca5736a775aceadb0a2a10140af61f94ed2ac
```

加强证据（整目录同 tree，排除"文件改名/移位"导致的漏报）：
```
$ git rev-parse dsh-v0.2.1-rc.2:packages/boot/app-boot/src  → 14016c958ce4f6006933056a4863c5bebb348daf
$ git rev-parse dsh-v0.2.1-rc.3:packages/boot/app-boot/src  → 14016c958ce4f6006933056a4863c5bebb348daf
```
raw 直链二次确认：两 tag 的该文件均 6093 字节，`diff` 无输出 [亲验]。

**判定语义（rc.3 现行实现，行号取自 raw 文件）**：
- L52：`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` —— 预发布版本参与比较，且空 range 视为不满足。
- L62-72：只有在**不存在 `engines.dsh`** 时才看 `peerDependencies`；只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀的 peer（本插件 peer `@deepseek-ai/dsh-pwsh-sandbox` 命中该前缀，会被检查）。
- L44-49 / L90：`runtimeVersion` 默认取 app-boot 自身 `package.json` 的 `version`（桌面端实测为 `0.2.1-rc.3`）。

**结论**：判定函数、语义、字段优先级在 rc.3 完全未变；本插件未声明 `engines.dsh`，因此走 peer 分支，受检的正是 sandbox 包的 range。

---

## 4. 核心问题 B：现有 peer range 在 includePrerelease 语义下是否覆盖 0.2.1-rc.3

被检 range（本插件 `package.json` peerDependencies）：
```
>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || 0.1.7-rc.2 || >=0.2.0-rc.1 <0.3.0-0
```

用 semver 7.7.3 实测 [亲验]：

| 版本 | includePrerelease:true（DSH 实际用法） | 默认语义 |
| --- | --- | --- |
| 0.2.1-rc.1 | true | false |
| 0.2.1-rc.2 | true | false |
| **0.2.1-rc.3** | **true** | false |
| 0.2.1 | true | true |
| 0.2.2 | true | true |
| 0.3.0-0 / 0.3.0 | false | false |

子范围单独验证：`satisfies("0.2.1-rc.3", ">=0.2.0-rc.1 <0.3.0-0", {includePrerelease:true})` = **true**；`lte("0.2.1-rc.3","0.3.0-0")` = true。

**结论：现有 peer range 无需改动即在 DSH 的 `includePrerelease:true` 语义下覆盖 0.2.1-rc.3。** [采信] lead 转述的 teammate 用 `evaluatePluginCompatibility(manifest,{},'0.2.1-rc.3')` 实测返回 `undefined`（= 兼容），与本结论一致。

---

## 5. 核心问题 C：桌面端装配的 sandbox 包是否与 npm 0.2.1-rc.3 一致

**一致（字节级）。**[亲验]

- 桌面端本质发版：`E:/Tool/DSH/resources/runtime/primary-runtime/runtime.json` → `desktopVersion: 0.2.1-rc.3`；`app.asar` 内 `dsh/package.json` → `@deepseek-ai/dsh-desktop-runtime` version `0.2.1-rc.3`。注意 `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 仍是 `0.2.1-rc.2`（本地缓存的旧 runtime payload，不影响 app.asar 内装配）。
- 解析路径：`app.asar/dsh/node_modules/@deepseek-ai/dsh-pwsh-sandbox/`（Electron asar fs 读取）。
- `package.json` → `"version": "0.2.1-rc.3"`。
- `lib/index.js` → 10407 B，SHA256 `bed19d2cea875b152f9e811116b59c2a45e6711b1c6cf1d8bacc4d20e15c6783`。
- npm 侧对照（`npm pack` 后解包，`sha256sum`）：rc.2 与 rc.3 的 `lib/index.js` 均为 `bed19d2cea…6783`；两版本除 `package.json` 外**全包 `diff -rq` 无差异**，`lib/types/**`、`locale/**` 完全相同，`package.json` 差异仅为 `version` 与 4~7 个内部依赖 pin（`dsh-shell`/`dsh-pwsh-local`/`dsh-sandbox`/`dsh-sandbox-policy`… 由 `0.2.1-rc.2` → `0.2.1-rc.3`）。

**结论：桌面端 0.2.1-rc.3 实际运行的 sandbox 执行器与 npm 上 `@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.3` 是同一份字节码**，即本插件继承的基类与覆写点与 npm rc.3 完全同构。[采信] teammate 的「asar 内 runtime/app-boot/pwsh-sandbox 均 0.2.1-rc.3、Electron 进程内 import 插件成功且 prototype chain 匹配」与本结论一致。

同时核对了其余关键包在 asar 内的版本均为 `0.2.1-rc.3`：`dsh-app-boot`、`dsh-base`、`dsh-plugin-manager` [亲验]。

---

## 6. 核心问题 D：profile 结构与补丁文法是否变化

- `packages/bundle/base/cordis.patch.yml` 两 tag 同一 blob `7d63cf26679f81565ecaf09e901dda6056894682`；第 255-256 行仍为 `- id: pwsh-sandbox` / `name: '@deepseek-ai/dsh-pwsh-sandbox'`，第 285-286 行仍为 `- id: tool-pwsh` [亲验]。→ 本插件 id-target 的锚点 id 未变。
- 补丁解析/应用实现：`packages/boot/app-boot/src/**` 整目录同 tree；`plugin-manager`、`config-editor` 仅 `package.json` 变动 [亲验]。→ `id` 定向覆盖、`disabled: true`、`insert:` 列表、`!!js` 表达式这四种文法在 rc.3 均未变。
- 上游唯一补丁文法相关变更是 `packages/bundle/web-app/cordis.patch.yml` 的 **新增一条 insert 行**（用的是既有文法，非文法演进），且属 web bundle，与 desktop profile 无关 [亲验]。
- 真实 desktop profile 现状（**只读查看，未安装/卸载/修改**）[亲验]：
  - `~/.dsh/profiles/desktop/cordis.yml` 第 273-274 行：`- id: pwsh-sandbox / name: '@deepseek-ai/dsh-pwsh-sandbox'`，第 275 行 `disabled: true`；第 1391-1393 行：`- id: rtk-pwsh-shell / name: dsh-pwsh-rtk-rewrite / disabled: !!js process.platform !== 'win32'`。即 id-target disable + insert 的装配形态在 0.2.1-rc.3 profile 中照旧成立。
  - `~/.dsh/profiles/desktop/package.json` 中 `"dsh-pwsh-rtk-rewrite": "1.1.5"`（已装版本），profile bundles 仍是 `@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile` 等，结构未变。
  - `~/.dsh/profiles/desktop/compatibility.json` 仅有两条豁免（`@michengai/dsh-agency-agents@1.0.6`、`dsh-skill-mcp-manager@1.2.0`，均绑定 `0.2.0-rc.2`），**本插件不在豁免名单中**——说明它靠自身 peer range 通过判定，与第 4 节结论互证。

---

## 7. 对 task-2 的两条实务提醒（与既定假设不同，请以实测为准）

1. **`^0.2.1-rc.2` 在 node-semver 默认语义下「会」匹配 0.2.1-rc.3**（实测 `satisfies("0.2.1-rc.3","^0.2.1-rc.2")` = **true**，`~0.2.1-rc.2`、`>=0.2.1-rc.2` 同样为 true）。任务描述里"^0.2.1-rc.2 不会选中 0.2.1-rc.3"的假设**不成立**。因此把 devDependency 改成显式 `0.2.1-rc.3` 仍值得做（**可重复性、避免隐性漂移**），但理由不是"范围不覆盖"，报告/README 不要写成"因为 ^ 选不到所以必须改"。[亲验]
2. npm 上 `@deepseek-ai/dsh-pwsh-sandbox` 的 dist-tag：`latest = 0.0.1-rc.1`、`next = 0.2.1-rc.3`，已发布到 `0.2.1-rc.3` 为止（**无 0.2.1 正式版**）。`npm view … versions` 列出 `0.2.1-rc.1/rc.2/rc.3`。故安装时必须钉精确版本，否则 `latest` 会回落到 `0.0.1-rc.1`。[亲验]

---

## 8. 结论与改动清单（逐条）

| # | 项目 | 是否需要改 | 证据 |
| --- | --- | --- | --- |
| 1 | `index.js`（继承 + `execute(spec)` 改写 `spec.command`） | **不需要** | sandbox 包 `lib/index.js` 字节相同（`bed19d2c…`，10407B），`lib/types/**` 相同 → `SandboxPwshExecutor`、`execute` 签名、`spec.command` 字段契约未变 [亲验] |
| 2 | `cordis.patch.yml`（`- id: pwsh-sandbox / disabled: true` + `insert` 挂载 `rtk-pwsh-shell`） | **不需要** | base patch 同 blob 且 `id: pwsh-sandbox` 仍在；patch 解析实现（`boot/app-boot/src`、`plugin-manager`、`config-editor`）无源码变更 [亲验] |
| 3 | `peerDependencies` range | **不需要**（保持最小 diff） | `includePrerelease:true` 下 0.2.1-rc.3 判为满足；teammate 用真实判定函数实测返回 undefined [亲验]+[采信] |
| 4 | `devDependencies`（版本对齐） | **建议改**（可重复性，非契约问题） | `^0.2.1-rc.2` 已能解析到 rc.3，但显式钉 `0.2.1-rc.3` 更稳；npm `latest` 是 `0.0.1-rc.1` [亲验] |
| 5 | 自身 `version` / README 兼容性章节 | 与契约无关，按 task-2/task-3 处理 | —— |
| 6 | 桌面端装配一致性 | 一致，无需动作 | asar 内 `dsh-pwsh-sandbox@0.2.1-rc.3` 的 `lib/index.js` 与 npm rc.3 同 SHA256 [亲验] |

---

## 9. 已核实 / 推断 / 无法验证 一览

**已核实（本报告 [亲验] 部分，均可按第 1 节方法复现）**
- 6 个提交、646 条变更记录；`packages/shell|sandbox|boot` 仅 `package.json` 变动；`bundle/base` 除 `package.json` 外无变动。
- `plugin-compatibility.ts` 两 tag 同 blob `2e4ca573…`；`boot/app-boot/src` 整目录同 tree。
- `bundle/base/cordis.patch.yml` 两 tag 同 blob `7d63cf26…`，`id: pwsh-sandbox` 仍存在。
- npm rc.2/rc.3 sandbox 包：`lib/index.js` 同 SHA256 `bed19d2cea…6783`（10407B），types/locale 全同，仅 `package.json` 版本与内部 pin 变动。
- 桌面端 asar 内 `dsh-pwsh-sandbox@0.2.1-rc.3` 的 `lib/index.js` SHA256 与 npm rc.3 **相同**；`dsh/package.json`、`dsh-app-boot`、`dsh-base`、`dsh-plugin-manager` 版本均 `0.2.1-rc.3`。
- semver 7.7.3 实测：现有 peer range 在 `includePrerelease:true` 下覆盖 `0.2.1-rc.3`（默认语义不覆盖）；`^0.2.1-rc.2` 默认语义即匹配 rc.3。
- 真实 desktop profile 的 `cordis.yml` 中 `pwsh-sandbox` 已被 `disabled: true`、`rtk-pwsh-shell` 已插入；`compatibility.json` 无本插件豁免条目。
- npm dist-tags：`latest=0.0.1-rc.1`、`next=0.2.1-rc.3`，最高已发版本 `0.2.1-rc.3`。

**采信 teammate（lead 转述，未重复执行）**
- `evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.3')` 实测返回 `undefined`（兼容）。
- Electron 进程内 import 本插件成功、prototype chain 匹配；隔离 profile 安装 1.1.6 tgz 无 incompatible 告警、patch 行生效。
- tree 条目数 18758/18815（口径含目录；我按纯文件条目测得 16297/16347，差量一致）。

**推断（有证据但未直接执行）**
- 因 patch 解析源码零变更 + base patch 同 blob，可推定 id-target disable 与 `insert` 在 rc.3 的运行时行为与 rc.2 完全一致；真正的运行期闭环由 teammate 的隔离 profile 安装冒烟覆盖。

**无法验证 / 未验证**
- 未在真实 desktop profile 上做安装/卸载或启动验证（按任务约束禁止；`~/.dsh/profiles/desktop` 仅只读查看）。
- 未验证 DSH Web（`apps/web`）链路下本插件行为：本插件补丁对 `process.platform !== 'win32'` 关闭，且 DSH 环境规定只用桌面端，未纳入范围。
- 手写 asar header 解析脚本失败原因未查明（已改用 Electron asar fs 读取绕过，不影响结论）。

---

## 10. 附：关键命令留痕（供复核）

```bash
# 取证仓库（/tmp/u3）
git clone --depth 1 --single-branch --branch dsh-v0.2.1-rc.3 --filter=blob:none --no-checkout \
  https://github.com/deepseek-ai/deepseek-harness u3        # 15.5s, .git 781K
git fetch --depth 1 origin refs/tags/dsh-v0.2.1-rc.2:refs/tags/dsh-v0.2.1-rc.2   # 3.7s
git diff-tree -r --name-status dsh-v0.2.1-rc.2 dsh-v0.2.1-rc.3 | wc -l          # 646
git diff dsh-v0.2.1-rc.2 dsh-v0.2.1-rc.3 -- packages/shell                       # 只有版本行
git ls-tree dsh-v0.2.1-rc.2 -- packages/boot/app-boot/src/plugin-compatibility.ts
git ls-tree dsh-v0.2.1-rc.3 -- packages/boot/app-boot/src/plugin-compatibility.ts
git rev-parse dsh-v0.2.1-rc.{2,3}:packages/boot/app-boot/src
git rev-parse dsh-v0.2.1-rc.{2,3}:packages/bundle/base/cordis.patch.yml

# npm 包对照
npm pack @deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.{2,3} --pack-destination /tmp/pk
diff -rq npmc2/package npmc3/package            # 仅 package.json 不同
sha256sum npmc{2,3}/package/lib/index.js        # 均为 bed19d2cea…6783

# 桌面端 asar（Electron 以 Node 模式读 asar）
ELECTRON_RUN_AS_NODE=1 "E:/Tool/DSH/DeepSeek Harness.exe" /tmp/probe4.js
#   KERNEL sb lib/index.js: bed19d2cea…6783 (10407B)
#   KERNEL sb version: 0.2.1-rc.3 / app-boot: 0.2.1-rc.3 / base: 0.2.1-rc.3 / plugin-manager: 0.2.1-rc.3
```
