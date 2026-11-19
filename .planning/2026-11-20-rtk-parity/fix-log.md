# 审查问题处置记录（lead）

审查者结论：**P0 阻塞项 0 个，修完 P1 可发布。** 五条 P1 全部处置完毕，P2 处置 4 条。

## P1

| 编号 | 问题 | 处置 | 复验 |
|---|---|---|---|
| P1-1 | `test.js:78` 的「假/真 rtk 输出完全一致（差异 0）」与事实不符，实测 11 条里 5 条不一致 | 改为逐条列出 5 条不一致及原因（假 rtk 不模拟分段改写/别名重映射/ENV 前缀保留），并保留「别拿假 rtk 反推真 rtk 语义」的告诫 | 注释与审查者 `review-fakecheck2.mjs` 的实测输出逐条对应 |
| P1-2 | 透明前缀不变量只在 C2 组（受 `RTK_TEST_FAST` 跳过）有断言，CI 上无裁判 | 在 **E 组纯函数段**新增 18 条透明前缀断言（`uv run`/`timeout`/`time`/`nice`/`noglob`/`command`/`exec`/`nocorrect` 的普通形态与「内部已是 rtk」形态 + `direnv exec .`），不依赖真 rtk | 审查者的 `mE_prefix_misjudged` 变异体：改前 FAST 全绿存活 → 改后 **FAST 17 项失败** |
| P1-3 | README 写「9 组」，实际 14 组 | 两份 README 的组数改为 14，并补全被漏掉的 C2/D2/E0/E1a/E1b 五个组的说明 | `RTK_TEST_FAST=1 node test.js \| grep -cE '^── '` = 14，组名逐个对齐 |
| P1-4 | `test.js` 死变量 `msg` | 删除该声明（后续断言本就用字面量） | 全量测试仍 563/563 |
| P1-5 | 恒等抑制的唯一裁判是「不打印改日志」，抑制与 `log()` 一起删掉的变异体能存活 | 在 A 组补「交回的必须是原 spec 引用」断言（`r.specs.at(-1) === identitySpec`） | 审查者的 `m7_no_guard_no_log`：改前 FAST 全绿存活 → 改后 **FAST 28 项失败** |

## P2

| 编号 | 问题 | 处置 |
|---|---|---|
| P2-1 | `index.js` 行号未标 ref | 注释改为「行号对应 `origin/develop` 的 `24ff2267`；旧 checkout `bd7f87e` 上是 `:836`/`:2008`」 |
| P2-2 | `mirrors` 与 `wider than upstream` 措辞矛盾 | 首句改 `parallels`，「wider」处补一句说明上游自身的测试是窄的字面量判定、本识别器有意接受更多写法 |
| P2-3 | 空白短路用 JS `trim()`，比 Rust `trim()` 少 U+0085 NEL | **确认为真缺口并修复**：改成 `/^[\s\u0085]|[\s\u0085]$/`。实测 `"rtk git status\u0085"` → rtk exit 3 + `"rtk git status"`（真实改写），旧实现 skip=true 会漏。E 组补 7 条边缘空白断言（NEL 前/后、\t、\n、NBSP、全角空格、U+2028） |
| P2-4 | README 仍贴 `分歧(漏改写): 1` | 已改为 0 并补 113 条加宽对拍的结论 |
| P2-5 | README（在 npm `files` 白名单内）含本机绝对路径 | `C:/Users/Sjc/...` 改为 `<rtk 绝对路径>` / `<absolute path to rtk>`；`/d/Code/_upstream/rtk` 改为「本地克隆的 `origin/develop`」 |
| P2-6 | `emptySegmentCases` 判 true 属「按实现写」 | 保留（审查者已确认 rtk 对这些形态全 exit 1，安全），不修 |

## 最终验证（lead 本人复跑）

```
node --test test.js            → 总计 563 项：通过 563 / 失败 0 / 与契约不一致 0 → ALL PASS
RTK_TEST_FAST=1 node test.js   → 总计 326 项：通过 326 / 失败 0 → ALL PASS
probe-parity.mjs               → 总用例: 47 | 分歧(漏改写): 0
lead-verify.mjs                → 113 条：不变式违规 0 / 多一次 spawn 43 → 不变式成立
```

变异验证（lead 本人构造并运行）：

| 变异体 | 改前 | 改后 |
|---|---|---|
| 删 exit 3 分支 | — | 137 项失败/不一致 |
| exit 2 采纳 stdout | — | 2 项失败 |
| 删空白守卫 | — | 10 项失败 |
| 守卫恒真 | — | 184 项失败/不一致 |
| 透明前缀误判（`mE`） | FAST 存活，非 FAST 7 项失败 | **FAST 17 项失败** |
| 抑制+日志同删（`m7`） | FAST 存活，非 FAST 全绿 | **FAST 28 项失败** |
| NEL 守卫退化回 `trim()` | 未覆盖 | **FAST 1 项失败** |
