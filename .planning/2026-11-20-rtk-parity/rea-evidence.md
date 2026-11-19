# REA 对 rtk.exe 的静态取证记录

## 目标

- 路径：`C:/Users/Sjc/.local/bin/rtk.exe`
- SHA256：`54a980783fc18816b51f2100d714fbe1c7ce1c3f9d88d65f38dd17ac849a0c25`
- 大小：18,560,000 字节
- 版本：`rtk 1.2.1`

## 已取得的 REA Evidence

| operation | evidence_id | 结论 |
|---|---|---|
| `inspect_artifact` | `ev_a0257991d228db2191f493248b7c8cd44d22833d23e6f2e1a70a13ed2e42c03c` | 单文件 PE，无嵌套归档；无可用字节清单（不是归档） |
| `inspect_pe_imports` | `ev_db2cd6948347ccf42cd75d3cf208a9d8efd7121ab3ebb4b30679ed2c1ba752e7` | PE32+ / machine 0x8664 / amd64，import directory RVA 18011572 size 440，**delay-import 目录为 null**；导入 `kernel32.dll` 等标准 Win32 + CRT |
| `inspect_pe_resources` | `ev_35faebf0e45bc3d2f17b5b8d4753e5f1b118365344cd02097b1ce1bc36139bf8` | `directories: []`、`resources: []`、`icon_groups: []`，coverage complete —— **无 PE 资源段** |
| `inspect_pe_load_config` | `ev_aedadcb7415b539ef6c6d68e950a54229eb13e69e12f3c8d1a009b1caa8575ea` | TLS 回调/load-config 事实 |
| `inspect_pe_certificates` | — | `IMAGE_DIRECTORY_ENTRY_SECURITY` 缺失，entries 0，coverage complete（REA 同时声明这不等于全局未签名） |

## 关键推论

**无 PE 资源段 ⇒ 改写规则表、权限规则、过滤器全部编译进 `.rdata`，不来自可改的资源文件。**
这从结构上排除了「通过替换资源段改变 rtk 行为」的假设，也说明本机二进制的行为只能靠
「源码定点取证 + 进程级 oracle + 字符串交叉验证」三路合围，而不能靠读资源。

## 无法取得的 REA 层

| 能力 | 状态 | 原因（REA 原文） |
|---|---|---|
| 反汇编 / 伪代码 | 不可用 | `GHIDRA_INSTALL_DIR` 未设；Hopper 不支持 win32；IDA/Kuna 未配置 |
| `list_procedures` / `list_strings` / `list_names` | 不可用 | 同上，`provider_unavailable` |
| `search_strings` | 参数契约不符 | 不认 `limit` 键（且底层 provider 不可用） |
| `capture_process_scenario` | 平台不支持 | 「Windows PTY process capture is unavailable because this adapter does not yet verify descendant cleanup. Use Linux（含 WSL）or macOS.」 |
| `inspect_binary_hardening` | 输入被拒 | `Analysis input is invalid`（同一路径 `inspect_pe_imports` 可读，疑为加固工具对 win32 路径/格式的独立校验） |

## 替代取证通道（本规范实际采用）

1. **上游源码定点**：`/d/Code/_upstream/rtk`，`origin/develop` = `dev-1.2.0-rc.620-147-g24ff2267`；
   与 v1.2.1 的差异仅在 `src/discover/registry.rs` 与文档，`rewrite` 契约三文件零改动。
2. **进程级 oracle**：本机 rtk 1.2.1 的 `rtk rewrite "<cmd>"` 真实退出码与 stdout，
   由 `.planning/2026-11-20-rtk-parity/probe-parity.mjs` 批量对拍插件判定。
3. **二进制字符串交叉验证**：`strings -a rtk.exe` 命中 `RTK_DISABLED=`(10)、
   `RTK_REWRITE_HOST`(2)、`uv run`(3)、`nocorrect`/`noglob`(各 1)、
   `transparent_prefixes`(1)、`exclude_commands`(5)、`pipeline rule`(5)，
   且完整内嵌了 `rewrite` 的四条退出码 help 文本（与 `src/lib.rs` 逐字一致）。
   这一步排除了「本机二进制契约与上游源码不同步」的可能。
