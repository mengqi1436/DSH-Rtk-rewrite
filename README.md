# dsh-pwsh-rtk-rewrite

**English** | [中文](./README_zh.md)

A native [rtk](https://github.com/rtk-ai/rtk) bridge plugin for DeepSeek Harness (DSH):
it replaces the desktop profile's shell executor with an rtk-rewriting subclass, so
**every pwsh shell command is transparently rewritten through `rtk rewrite "<cmd>"`
before execution**, letting rtk's compact output format save tokens on every tool call.
When rtk explicitly denies a command, the command is blocked instead of executed;
everything else (rtk missing, no equivalent, timeout) still runs unchanged.

Verified on a real machine (2026-09-25, dsh 0.1.7-rc.2 + rtk 0.50.0 + Node v24.19.0):

```
[rtk-rewrite] "git status" -> "rtk git status"
[rtk-rewrite] "cat E:\\CLI\\dsh-web.log" -> "rtk read E:\\CLI\\dsh-web.log"
# Even compound commands are rewritten segment by segment:
"cat a.log; git status; grep -c x b.log"
  -> "rtk read a.log; rtk git status; rtk grep -c x b.log"
```

`rtk gain` climbs in real time as commands run (experiment: Total commands 10274 → 10277,
matching the 3 rewrite log lines in dsh-web.log one to one).

> That run predates rtk 1.0's four-way contract and is kept as the historical
> rtk 0.50.0-era observation. The exit-code mapping documented below is the one
> re-verified against **rtk 1.0.1 on 2026-10-20**.

## Compatibility

**0.2.0** (verified 2026-09-29): `@deepseek-ai/dsh-pwsh-sandbox@0.2.0-rc.1`'s
`lib/index.js` is **byte-identical** to `0.1.7-rc.2` (252 lines, 0 diff). The
`SandboxPwshExecutor` named export, the `execute(spec)` signature, and the resolve()
policy-stamp layer are all unchanged — this plugin needs **no code change**;
peerDependencies was widened to `>=0.2.0-rc.1 <0.3.0-0` (since v1.1.0).

**0.2.0-rc.2** (verified 2026-09-30): `@deepseek-ai/dsh-pwsh-sandbox@0.2.0-rc.2`'s
`lib/index.js` is **byte-identical** to `0.2.0-rc.1` (same SHA256 `BED19D2C…`, 252
lines, 0 diff). The only in-package changes are version numbers in `package.json`
(rc.1 → rc.2) — the persistent-PowerShell fix in rc.2 ("command-end detection fails
when the completion status is followed by a space, losing exit codes or leaking
internal markers") lives in the dsh kernel, not in this sandbox package. The
`dsh-pwsh-sandbox` copy bundled inside the desktop 0.2.0-rc.2 `app.asar` was also
extracted and compared: byte-identical to the npm rc.2 (same SHA256).

**0.2.1** (verified 2026-10-17): `@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.2`'s
`lib/index.js` is **byte-identical** to `0.2.0-rc.2` (same SHA256 `BED19D2C…`,
0 diff) — the whole 0.2.1 line so far touched only README/locale/package.json
metadata. The desktop 0.2.1-rc.1 `app.asar` was extracted and bundles the same
byte-identical copy; the `pwsh-sandbox` cordis line is still present in the
kernel, and the upstream changelog (v0.2.1-rc.1/rc.2) contains no
shell-executor or patch-mechanism breaking changes. This plugin needs **no
code change**; the existing peer range `>=0.2.0-rc.1 <0.3.0-0` already covers
0.2.1-rc.1/rc.2, and `test.js` now loads the devDependency copy of
`0.2.1-rc.2` under bare node to keep exercising the subclassing contract.

**DSH desktop 0.2.1-rc.2** (verified 2026-10-20, v1.2.0): `@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.2`'s
`lib/index.js` is still **byte-identical** to `0.2.0-rc.2` (same SHA256 `BED19D2C…`,
252 lines, 0 diff — re-hashed locally from the devDependency copy). It is also what
the local desktop app runs: npm `@deepseek-ai/dsh` publishes the same 0.2.1-rc.2 as
both `latest` and `next`, the newest upstream tag is `dsh-v0.2.1-rc.2`, and everything
merged on master after rc.2 touches only web/llm — nothing under shell, sandbox, patch
or executor. **No kernel upgrade needed, no plugin code change**: the four-way
contract shipped in v1.2.0 lives entirely in this plugin's `execute()`, on top of the
unchanged `SandboxPwshExecutor`.

**Desktop adaptation** (verified and fixed on a real machine 2026-09-30, v1.1.3):
the desktop 0.2.0-rc.2 dsh kernel is packaged inside `resources\app.asar`; neither
the desktop profile's dependency chain nor the node-directory layouts can resolve the
kernel package, so the plugin's original four probe chains all missed → the
`rtk-pwsh-shell` service failed to load and the patch silently fell back to the
native shell (the assembly-layer patch declaration itself was correct — confirmed by
actually probing `loadProfileDirectory`). v1.1.3 adds a fifth **Electron desktop
layout probe chain** `<exe dir>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`,
which hits in the desktop main process (thanks to Electron's asar fs support);
`node test.js` passes all 6 checks in that same shape. After installing v1.1.3,
**restart the desktop app** and it works — no `DSH_INSTALL_PACKAGE_JSON` needed.

## Requirements

- **DeepSeek Harness ≥ 0.1.7 (including 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.1 /
  0.2.1-rc.2)** desktop app
  (`dsh` CLI with the `dsh plugin` mechanism)
- **rtk ≥ 1.0.0** on PATH — the four-way `rtk rewrite` exit-code contract starts
  there (re-verified against **rtk 1.0.1 on 2026-10-20**; use `RTK_BIN` to point at
  an alias). An older rtk, or an `RTK_BIN` that resolves to some other CLI, is
  **detected and degraded to pass-through**: commands run unrewritten, nothing is
  blocked, and one warning says so.
- Windows + PowerShell (the plugin replaces the pwsh executor; bash/other shell
  tools are unaffected)

## How It Works

DSH's plugin system (cordis) lets a bundle replace service lines via a patch
declaration. Each context allows exactly one `ctx.shell` implementation, so the
patch does two things:

1. **Disable the original executor**: `- id: pwsh-sandbox / disabled: true`
2. **Insert this plugin**: `insert: - id: rtk-pwsh-shell / name: 'dsh-pwsh-rtk-rewrite'`

Once loaded, shell capability is provided by `RtkPwshExecutor`:

```
execute(spec)
  ├─ RTK_DISABLED=1 ? ──────────────────────────► run as-is (rtk opt-out; bypasses deny too)
  ├─ command starts with "rtk "/"rtk.exe " ? ───► run as-is (recursion guard)
  ├─ rtk supports "rewrite"? ── no ─────────────► run as-is (pass-through, never deny)
  ├─ rtk rewrite "<cmd>" (5s timeout)
  │    ├─ exit 0 / exit 3   ──► super.execute({...spec, command: rewritten})
  │    ├─ exit 1            ──► no rtk equivalent (pwsh cmdlets etc.), silently run as-is
  │    ├─ exit 2            ──► DENY: command never executed; synthesized failed handle
  │    │                        (exitCode 2, plugin's own note on stderr; RTK_DISABLED=1 bypasses)
  │    ├─ ENOENT            ──► rtk not on PATH, warn once, run as-is
  │    └─ timeout / other   ──► run as-is
  └─ super.execute(spec)   (SandboxPwshExecutor: sandbox confine wraps the executed command)
```

### Key Design Decisions

- **Default allow, exactly one fail-closed branch**: every rewrite failure (rtk
  missing, no equivalent, timeout, unexpected error, an rtk without `rewrite`)
  runs the original command. Execution is blocked in only one case: rtk explicitly
  denies the command (`exit 2`, and only after the capability probe confirmed this
  rtk has a `rewrite` subcommand). A denied command is never spawned.
- **A capability probe replaces guessing from stderr**: clap also exits 2 for an
  unknown subcommand and for usage errors, so the exit code alone cannot separate
  "deny" from "this rtk is too old". The plugin therefore runs
  `<rtk> rewrite --help` before the first rewrite and treats exit 0 as "supports
  `rewrite`". An rtk without the subcommand (rtk < 1.0, or `RTK_BIN` pointing at
  some other CLI) never reaches the four-way logic at all — so it can never be
  judged as a deny, and the shell keeps working unrewritten. The probe result is
  cached: capable is cached forever (zero per-command cost), incapable is
  re-probed after 60 s so an in-place `rtk` upgrade recovers by itself; the
  warning is printed once. This is precisely what keeps an external binary's
  version mismatch from turning the whole shell into a rejector.
- **A deny returns a synthesized failed handle**: no process exists, and the DSH
  result types have no dedicated "not executed" field, so the plugin builds the
  `ShellExecution` shape itself — `status: 'completed'`, `exitCode: 2`, its own
  denial note in `stderr` (also reachable via `readOutput()` and
  `observed.stderr`), `kill()` a no-op, `done` already settled. On rtk 1.0.1 an
  rtk-supplied reason never exists (exit 2 prints nothing), so the note is the
  plugin's own text: `rtk denied this command; it was not executed.` A message is
  read from stdout only, dropping lines that start with `[rtk] `, so the hook-noise
  hint can never be mistaken for a denial reason. Callers get a failure carrying an
  explanation, not an empty success.
- **`sandbox.denied` keeps the sandbox's own meaning**: that flag reports whether
  the sandbox refused a file operation. An rtk deny leaves it `false`; the denial
  is expressed through a non-zero `exitCode` plus `stderr` instead.
- **`[rtk] No hook installed` on stderr is harmless and left alone**: rtk prints
  that 79-byte hint on every `rewrite` call in all four exits, with no throttle and
  no `--quiet` flag (it can only be suppressed via `RTK_SUPPRESS_HOOK_WARNING=1|on`
  or `suppress_hook_warning = true` in rtk's own config). The plugin reads only
  stdout, so the noise never affects a decision, and it deliberately does not set
  that variable — that would change the user's global rtk environment for no gain.
- **Sandbox semantics fully preserved**: only `execute(spec)` is overridden;
  `resolve()` (the sandbox policy stamp) is untouched. The spec is passed on as
  `{ ...spec, command: rewritten }`, keeping workdir/timeoutMs/signal/stdin/env and
  all sandbox fields intact. The sandbox confine wraps the **rewritten** command.
- **`spec.command` is the raw command**: the UTF-8 preamble is only prepended at the
  spawnSpec layer inside `PwshLocalExecutor` (lib/index.js), so the command text seen
  by `execute()` is safe to feed to `rtk rewrite` directly.
- **The bundled package resolves from the dsh install itself**: the npm copy of
  `@deepseek-ai/dsh-pwsh-sandbox` often lags (or diverges from) the copy shipped
  inside the running host (the registry sat at 0.1.5-rc.3 for a long stretch; 0.2.0
  resumed publishing but the desktop bundle may still assemble a different rev), so
  the core package is declared as a peerDependency (for the market's host-aware
  compatibility discovery) while at runtime it is auto-probed in order:
  `DSH_INSTALL_PACKAGE_JSON` env var → normal dependency chain → Windows layout
  `<node dir>/node_modules/@deepseek-ai/dsh` → POSIX nvm layout
  `<node dir>/../lib/node_modules/@deepseek-ai/dsh` → Electron desktop layout
  `<exe dir>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`
  (since v1.1.3; fs is asar-transparent inside the desktop main process, verified hit).
- **rtk exit-code semantics** (four-way, one-to-one with `rtk rewrite --help` of
  rtk 1.0.1, re-verified against the 1.0.1 source on 2026-10-20): `0` — rewrite
  printed, the allow rules cover every command → run the rewrite; `1` — nothing
  printed, no rewrite (no RTK equivalent, a command excluded in config, a construct
  rtk does not rewrite such as `$(...)` or a file redirect, or a deny rule matched
  inside a shell wrapper's script) → run the original silently; `2` — a deny
  matched, checked before anything else → block. **`rtk rewrite` prints nothing at
  all on exit 2**: `src/hooks/rewrite_cmd.rs` exits straight from the `Deny` arm,
  and the exit-2 row of the upstream contract table reads `(none)`. The
  "A message printed: an rtk pipeline rule denied or routed" half of the `--help`
  text describes the in-process `rtk hook <agent>` JSON path (whose exit code is
  always 0), not this subcommand. `3` — rewrite printed, an ask rule matched or the
  allow rules do not cover every command → use the rewrite and defer approval to
  the host (this plugin has no approval channel, so it simply runs the rewrite).
- **exit 0 and exit 3 print byte-identical stdout** — the same `rtk <cmd>` text —
  so the exit code is the only thing separating "allow rules covered it" from "the
  host would have to approve". All four tiers must therefore be read from the exit
  code, never from whether stdout is non-empty.
- **The rule source is Claude Code's settings, not rtk's own config**: `0`/`2` come
  from `.claude/settings*.json` (the cwd and its ancestors), while rtk's own config
  under `%APPDATA%\rtk\` only feeds `[hooks] exclude_commands` and the like. This
  workspace has no `.claude` anywhere up the tree, so on this machine only exits 1
  and 3 actually occur; 0 and 2 need a `permissions.allow` / `permissions.deny`
  entry to be provoked.
- **Upstream 1.0.2 does not change the contract**: `src/hooks/rewrite_cmd.rs` on
  develop is byte-identical to v1.0.1 (12,290 B); the `decision.rs` changes there
  only touch the agent path.
- **Node v24 exit-code plumbing**: `execFile` surfaces the child exit code on
  `err.code` (a number) while spawn failures (ENOENT) put a string there, so all
  checks go through `Number(err.code)`.
- **`RTK_DISABLED=1` is honored at the plugin's JS layer only** (index.js checks it
  before rewriting, and it bypasses a deny too). The `rtk rewrite` subcommand
  itself does not observe this variable (re-verified with rtk 1.0.1): running
  `rtk rewrite` by hand with `RTK_DISABLED=1` still rewrites.

## Install / Uninstall

**Prerequisite**: DSH desktop **0.2.0-rc.2+** bundles the `dsh` command — click
**"Manage dsh command"** in the desktop menu bar to install it; no separate
Node/pnpm needed.

**Install** (pin the exact version: `@latest` gets rolled back to an older release
by the release-age check):

```powershell
dsh plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.2.0 --registry=https://registry.npmjs.org/
```

**Uninstall**:

```powershell
dsh plugin --profile desktop remove dsh-pwsh-rtk-rewrite
```

You can also install it from the DSH built-in plugin market
([dshmarket](https://github.com/dsh-market/dsh-market)). Restart the desktop app /
start a new session after installing (replacing installed code needs a restart to
load the new module).

**Kernel package resolution**: the desktop dsh kernel is packaged inside the install
directory's `app.asar` (on Windows e.g. `E:\Tool\DSH\resources\app.asar\dsh\`), and
neither the desktop profile's dependency chain nor the node-directory layouts can
find it. **Since v1.1.3 the plugin ships an Electron desktop layout probe chain that
hits the `app.asar` kernel package automatically inside the desktop process — no
configuration needed.** Older versions (≤ 1.1.1) silently fall back to the native
shell on desktop because resolution fails (symptom: plugin installed but rtk never
fires); the manual workaround was setting `DSH_INSTALL_PACKAGE_JSON` in the
**desktop process environment** to
`<desktop install dir>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json`.
Upgrading to v1.1.3 removes the need for that variable.

**Verify**: after restarting the desktop app, run a command rtk definitely knows
(e.g. `git status`) and check that `rtk gain`'s Total commands count climbs — or look
for rtk's compact format in the tool output.

**Effective**: the desktop app is the same Windows + pwsh environment, so the plugin
works as usual; **restart the desktop app** after installation.

## Disabling

- **Single command**: environment variable `RTK_DISABLED=1` (rtk's own convention;
  the plugin honors it at the JS layer, and it bypasses an rtk deny as well)
- **Whole line**: in the profile patch, override the `rtk-pwsh-shell` line with
  `disabled: true` and restore the `pwsh-sandbox` line with `disabled: false`

## Verification

```powershell
node test.js               # 40 checks + 1 expected skip
```

What `test.js` covers — against the real `rtk 1.0.1` on PATH plus a fake-rtk stub
that runs as a real child process and returns real exit codes:

- **the four-way contract**: exit 0 → rewrite, exit 3 → rewrite, exit 1 → no
  rewrite, exit 2 → deny result. Real rtk 1.0.1 prints nothing on exit 2, so the
  note is the plugin's own text; the stub also covers a message-carrying exit 2
  (message on stdout) and a noise-only exit 2, where the `[rtk] ` lines must be
  dropped — the hook hint can never become a denial reason
- **deny is fail-closed**: `super.execute()` is never called, the synthesized
  handle settles with `exitCode: 2`, its stderr states the command was denied and
  not executed, `sandbox.denied` stays `false`, `kill()` is a no-op and
  `readOutput()` is consuming
- **rewrite path**: the rewritten command reaches `super.execute()` with the rest
  of the spec (workdir, timeoutMs) preserved; `RTK_DISABLED=1` and the recursion
  guard both bypass rewriting — the first one even bypasses a deny
- **capability-probe degradation**: a legacy rtk whose `rewrite` is an unknown
  subcommand (clap exits 2) and an `RTK_BIN` pointing at an unrelated real binary
  both degrade to pass-through, never to deny; the probe is cached (one probe
  across many executions, not one per command), and the recursion guard bypasses
  before any probe

The real-desktop asar check prints `skip:` under bare node — asar is only readable
inside the Electron main process, so that skip is expected. The suite loads the
devDependency copy of the sandbox package, so it keeps exercising the subclassing
contract against `0.2.1-rc.2`.

Runtime verification (three mutually confirming pieces of evidence):

1. **Harness log**: `[rtk-rewrite] "orig" -> "rewritten"` appears when shell commands
   run (in web mode it lands in the startup-redirected log file, e.g. `dsh-web.log`)
2. **rtk history.db** (`C:\Users\<user>\AppData\Local\rtk\history.db`): every
   successful rewrite is recorded as an `original_cmd → rtk_cmd` row
3. **`rtk gain`**: the Total commands count climbs as commands execute

> Note: pick probe commands rtk **definitely knows** (`git status`, `cat`, etc.).
> pwsh-specific commands (`Write-Output`, bare `Get-ChildItem`, …) make rtk exit 1
> with no equivalent — silent and unrecorded. **No record ≠ plugin not working**;
> this is the most common pitfall when troubleshooting.

## File Layout

```
├── index.js          # RtkPwshExecutor (only source: rtkRewrite + execute interception)
├── cordis.patch.yml  # bundle patch: disable pwsh-sandbox + insert rtk-pwsh-shell
├── package.json      # dsh.bundle.patch points at the patch file; no runtime dependencies
├── test.js           # self-check: four-way contract + fake-rtk stub + probe degradation (40 checks)
├── README.md         # English (this file)
└── README_zh.md      # 中文
```

## License

[MIT](LICENSE) © 2026 mengqi1436
