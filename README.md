# dsh-pwsh-rtk-rewrite

**English** | [中文](./README_zh.md)

A native [rtk](https://github.com/rtk-ai/rtk) bridge plugin for DeepSeek Harness (DSH):
it replaces the desktop profile's shell executor with an rtk-rewriting subclass, so
**every pwsh shell command is transparently rewritten through `rtk rewrite "<cmd>"`
before execution**, letting rtk's compact output format save tokens on every tool call.

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

- **DeepSeek Harness ≥ 0.1.7 (including 0.2.0-rc.1 / 0.2.0-rc.2)** desktop app
  (`dsh` CLI with the `dsh plugin` mechanism)
- **rtk ≥ 0.50.0** on PATH (`rtk rewrite` subcommand available; use the `RTK_BIN`
  environment variable to point at an alias). Contract re-verified against rtk
  0.51.0 on 2026-10-03: exit-code semantics unchanged.
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
  ├─ RTK_DISABLED=1 ? ────────────────► run as-is
  ├─ command starts with "rtk "/"rtk.exe " ? ──► run as-is (recursion guard)
  ├─ rtk rewrite "<cmd>" (5s timeout)
  │    ├─ exit 3 + stdout ──► super.execute({...spec, command: rewritten})
  │    ├─ exit 1            ──► no rtk equivalent (pwsh cmdlets etc.), silently run as-is
  │    ├─ ENOENT            ──► rtk not on PATH, warn once then run as-is
  │    └─ timeout/other     ──► run as-is
  └─ super.execute(spec)   (SandboxPwshExecutor: sandbox confine wraps the rewritten command)
```

### Key Design Decisions

- **Fail-safe**: any rewrite failure (rtk missing, no equivalent, timeout, error)
  runs the original command. Execution is never blocked or denied by this plugin —
  it is purely additive.
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
- **rtk exit-code semantics** (verified with rtk 0.50.0, re-verified with 0.51.0 on
  2026-10-03; differs from `--help`, which claims "exits 0"): a supported command —
  including one already in rtk form — exits 3 with the command on stdout; no
  equivalent exits 1 with no output. Node v24's execFile surfaces the child exit code
  on `err.code` (a number), while spawn failures (ENOENT) put a string there, so all
  checks go through `Number(err.code)`.
- **`RTK_DISABLED=1` is honored at the plugin's JS layer only** (index.js checks it
  before rewriting). The `rtk rewrite` subcommand itself does not observe this
  variable (verified with rtk 0.51.0): running `rtk rewrite` by hand with
  `RTK_DISABLED=1` still rewrites.

## Install / Uninstall

**Prerequisite**: DSH desktop **0.2.0-rc.2+** bundles the `dsh` command — click
**"Manage dsh command"** in the desktop menu bar to install it; no separate
Node/pnpm needed.

**Install** (pin the exact version: `@latest` gets rolled back to an older release
by the release-age check):

```powershell
dsh plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.1.3 --registry=https://registry.npmjs.org/
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
  the plugin honors it at the JS layer)
- **Whole line**: in the profile patch, override the `rtk-pwsh-shell` line with
  `disabled: true` and restore the `pwsh-sandbox` line with `disabled: false`

## Verification

```powershell
node test.js               # rtkRewrite decision-logic self-check + module load
                           # (module load only passes inside the Electron desktop
                           #  main process; bare node cannot read the asar kernel
                           #  package, so that check reports failure there)
```

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
├── package.json      # dsh.bundle.patch points at the patch file; no npm dependencies
├── test.js           # minimal self-check: rewrite decision rules + module load
├── README.md         # English (this file)
└── README_zh.md      # 中文
```

## License

[MIT](LICENSE) © 2026 mengqi1436
