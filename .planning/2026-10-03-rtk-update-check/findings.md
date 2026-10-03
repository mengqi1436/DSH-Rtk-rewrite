# 调研发现：rtk-ai/rtk 上游更新核查（2026-10-03）

## 版本事实（三信源交叉验证）

- **本机 rtk：0.51.0**（`rtk --version`，位于 C:\Users\ASUS\.local\bin\rtk.exe）
- **上游最新正式版：v0.51.0**（2026-10-02 发布，即昨天）——本机已是最新。
- 0.51.0 之后只有 dev 预发布（dev-0.51.1-rc.494~501，0.51.1 未正式发布），无新正式版。
- 信源：[CHANGELOG.md](https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/CHANGELOG.md)（顶部最新条目 0.51.0）；gh api repos/rtk-ai/rtk/releases；[releases 页面](https://github.com/rtk-ai/rtk/releases)（维护滞后，最新稳定条目只到 v0.47.0，不作准）。

## 0.50.0 → 0.51.0 与插件相关的变更（基线是 README 实测的 0.50.0）

来源：[v0.51.0 release notes](https://github.com/rtk-ai/rtk/releases/tag/v0.51.0)

1. **唯一 BREAKING CHANGE**：`rtk test` 位置参数不再隐式 shell 展开，复合命令需显式 `rtk test --shell sh '...'`。**不在插件调用路径上**（插件只调 `rtk rewrite`）。
2. **rewrite 退出码契约**：无变更条目。0.49.0 的 rewrite 增强（管道内改写、sudo 透传等）早于 0.50.0 基线，已包含在现有行为中。
3. **RTK_DISABLED**：无变更。
4. **rtk gain / history.db**：仅统计口径优化（recall/tee 修复 9833d66 及回滚 f9f4092），无 breaking。
5. 新增改写覆盖：0.50.0 加了 `rtk ast-grep`；0.51.0 无新增。覆盖扩大对插件是透明增益，无需改代码。

## 本机契约实测（local-contract-verify，rtk 0.51.0 on Windows）

| 命令 | 实测 | 插件假设 | 符合 |
|---|---|---|---|
| `rtk rewrite 'git status'` | exit 3 + `rtk git status` | exit 3 取 stdout | ✅ |
| `rtk rewrite 'Write-Output hi'` | exit 1 无输出 | 静默透传 | ✅ |
| `rtk rewrite 'rtk git status'` | exit 3 恒等输出 | execute 层 `rewritten !== command` 跳过 | ✅ |
| `rtk rewrite 'cat a.log; git status'` | exit 3 逐段改写 | 正常接管 | ✅ |
| `RTK_DISABLED=1` 下 rtk 侧 rewrite | **仍改写**（rtk 侧不认此变量） | 插件 JS 层自查跳过（index.js:138），不依赖 rtk 侧 | ✅ |

- `rtk rewrite --help` 文档声称 "exits 0"，实测仍是 exit 3——index.js:94-99 按实测写的注释仍然正确。
- Node execFile 的 `err.code` 为数字，`Number(err.code)` 判定匹配。
- `rtk gain` 健康：累计 12990 条命令、省 4.7M tokens（76.9%）；history.db 存在。

## 插件 ↔ rtk 耦合点（11 项，全部健康）

退出码语义、RTK_BIN、RTK_DISABLED（JS 层）、超时 5000ms、递归防护、stderr 警告文案、ENOENT 单次警告、PATH 上 rtk 存在性、dsh 内核包解析（⚠️ 仅 Electron 内可解）、SandboxPwshExecutor 基类契约、cordis.patch.yml 挂载。详见 teammate 报告。

## 风险点（不影响当前，供未来参考）

1. rtk 0.51.0 每次 rewrite 调用 stderr 附带 `[rtk] /!\ No hook installed` 警告。插件只读 stdout，当前无害；若未来 rtk 把它挪进 stdout 会污染改写结果——下次升级复测。
2. RTK_DISABLED 对 rtk 侧 `rtk rewrite` 无效是 rtk 自身行为；插件防御正确，但 README 未点明这一点（属文档细节，非 bug）。
