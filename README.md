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

Re-confirmed on this machine 2026-11-08 (Windows 11 10.0.26300 + rtk 1.1.0 + Node
v26.13.0 + DSH desktop 0.2.2-rc.1): the exit-code contract is unchanged, and the whole
command-family table below was measured with `rtk rewrite` on that same day.

**No allow-list, no per-command config, nothing to register.** The plugin forwards the
whole command string to `rtk rewrite` and uses whatever rtk returns, so coverage equals
**whatever your installed rtk knows** — all 12 command families (see
[Supported command families](#supported-command-families)) work the day the plugin is
installed, and every command family rtk adds later works without a plugin update.

## Supported command families

rtk groups its filters by ecosystem under `src/cmds/`
([upstream layout](https://github.com/rtk-ai/rtk/tree/develop/src/cmds)): 11 ecosystem
directories plus the language-agnostic `system` bucket, 12 families in total (the
directory listing and `src/cmds/mod.rs` agree: `cloud dotnet git go js jvm php python
ruby rust scala system`). The table lists what each family rewrites; every entry below
was verified on this machine by running `rtk rewrite` and checking for a non-empty
rewrite.

| Family | Representative commands that get rewritten |
|--------|--------------------------------------------|
| **cloud** | `aws …`, `docker ps`, `kubectl get`, `oc get`, `curl`, `wget`, `psql`, `gcloud`, `helm`, `terraform plan`, `tofu plan`, `pulumi preview`, `ansible-playbook`, `rsync`, `sops`, `iptables`, `systemctl status`, `ping`, `skopeo`, `ssh`, `brew install`, `composer install`, `liquibase` |
| **dotnet** | `dotnet build`, `dotnet restore` |
| **git** | `git status/log/diff/show/add/commit/checkout/push/pull/branch/fetch/stash/worktree/ls-tree`, `gh pr/issue/run/repo/api/release`, `glab mr/issue/ci/pipeline/api/release`, `gt …`, `jj …`, standalone `diff` |
| **go** | `go test/build/vet`, `golangci-lint run` |
| **js** | `npm`/`pnpm`/`npx`/`bun`/`bunx`/`deno` invocations, `tsc`, `eslint`/`biome`/`lint`, `prettier`, `next build`, `ng build`, `jest`, `vitest`, `playwright`, `prisma` |
| **jvm** | `mvn`/`./mvnw`/`mvnd`, `./gradlew`/`gradle` |
| **php** | `php artisan …`, `php -l`, `phpunit`, `phpstan analyse`, `pest`, `paratest`, `ecs`, `pint`, `phpt` |
| **python** | `pytest`, `python -m pytest`, `ruff check/format`, `mypy`, `python -m mypy`, `pip list/outdated/install/show`, `uv run/sync/pip install`, `sqlfluff lint`, `poetry install/lock/update`, `basedpyright` |
| **ruby** | `bundle install/update`, `rake test`, `rails test`, `rspec`, `rubocop` |
| **rust** | `cargo build/test/clippy/check/fmt/install` |
| **scala** | `sbt test/testOnly/testQuick/compile/run/clean/assembly/package` |
| **system** | `cat`/`head`/`tail` (→ `rtk read`), `grep`, `rg`, `ast-grep`, `ls`, `find`, `tree`, `wc`, `diff`, `ctest`, `du`, `df`, `ps`, `stat`, `jq`, `just`, `make`, `mix`, `pio run`, `quarto render`, `task`, `turbo`, `trunk build`, `nx`, `yamllint`, `shellcheck`, `markdownlint`, `hadolint`, `gcc`, `ty` |

Beyond the 12 source families, rtk also ships TOML-defined filters
(`src/filters/*.toml`, 62 of them upstream). They go through the same
`rtk rewrite` entry point, so they need no plugin change either.

Commands with no rtk equivalent exit 1 and run untouched. In practice that means
**pwsh cmdlets and shell builtins**: `Get-ChildItem`, `Get-Process`, `Write-Output`,
`echo`, `env`, plus anything rtk deliberately leaves alone (`sudo …`, commands with a
write redirect such as `git status > out.txt`, `gh` with `--json`, `cat` with flags other
than `-n`). That is expected: no equivalent means no savings, not a failure.

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
0.2.1-rc.1/rc.2, and `test.js` loaded the devDependency copy of `0.2.1-rc.2` under
bare node to keep exercising the subclassing contract (that pin has since moved to
`0.2.1-rc.3`, see the next entry).

**0.2.1-rc.3** (verified 2026-10-24): `@deepseek-ai/dsh-pwsh-sandbox@0.2.1-rc.3`'s
`lib/index.js` is **byte-identical** to `0.2.1-rc.2` (same SHA256 `BED19D2C…`, 252
lines, 0 diff); the only in-package diff is `package.json` — the package version and
its internal dependency pins (rc.2 → rc.3). The upstream
[dsh-v0.2.1-rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)
changelog carries no shell-executor or patch-mechanism breaking changes: a full tree
diff against `dsh-v0.2.1-rc.2` shows `packages/shell/**`, `packages/sandbox/**` and
`packages/subprocess/**` touching only their `package.json` versions (no source
files), and the patch-grammar file `packages/bundle/base/cordis.patch.yml` is
identical across the two tags (the only `cordis.patch.yml` change is one added UI
entry-customization line in the web bundle). This plugin needs **no code change**;
the existing peer range `>=0.2.0-rc.1 <0.3.0-0` already covers 0.2.1-rc.3 under
DSH's `semver.satisfies(..., { includePrerelease: true })` check. At the time of this
check `test.js` still loaded the devDependency copy of `0.2.1-rc.3`; the suite has since
moved to a stubbed host package injected through `DSH_INSTALL_PACKAGE_JSON`, so it no
longer depends on that pin being installed. This entry was verified by comparing
the npm packages and the upstream repository trees — no desktop re-installation test
was run for it.

**0.2.2-rc.1** (verified 2026-11-08, against upstream `master` HEAD `fcc0ad4`): no
breaking change on any of the four contract surfaces this plugin depends on.
`packages/shell/shell/src/types.ts` — `ShellExecRequest`, `ShellExecSpec` (same ten
fields, same nullability), `ShellRunResult`, `ShellProcess`, `ShellExecution`,
`ShellSandboxInfo`, `ShellExpiryPolicy` — is field-for-field identical to 0.2.1-rc.5;
`SandboxPwshExecutor` still extends `PwshLocalExecutor` with `execute(spec)` as an
`override` (not `final`), still runs its three branches (`danger-full-access` /
confined / `confined === undefined`), and still memoizes the result handle in place;
`packages/shell/pwsh-sandbox` and `packages/shell/pwsh-local` keep their `Config`
fields, `resolve` logic, `argv()` (including the encoding preamble) and `onProcessDone`
signature. The patch grammar is unchanged — the base bundle's
`- id: pwsh-sandbox` line is still there, so the id-target still lands. The plugin stays
correct with **no code change**; the peer range `>=0.2.0-rc.1 <0.3.0-0` covers
0.2.2-rc.1 as well (verified with the same `satisfies(..., { includePrerelease: true })`
semantics DSH uses). Two caveats stated plainly: the local checkout of the upstream
repo is a `--depth 1` shallow clone with no per-package CHANGELOGs, so this comparison
was made file-by-file against the sources at `master` rather than against a commit
range; and `devDependencies` still pins `0.2.1-rc.3`, which only affects local
type/debug reference and not runtime resolution.

**Desktop adaptation** (verified and fixed on a real machine 2026-09-30, v1.1.3):
the desktop 0.2.0-rc.2 dsh kernel is packaged inside `resources\app.asar`; neither
the desktop profile's dependency chain nor the node-directory layouts can resolve the
kernel package, so the plugin's original four probe chains all missed → the
`rtk-pwsh-shell` service failed to load and the patch silently fell back to the
native shell (the assembly-layer patch declaration itself was correct — confirmed by
actually probing `loadProfileDirectory`). v1.1.3 adds a fifth **Electron desktop
layout probe chain** `<exe dir>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`,
which hits in the desktop main process (thanks to Electron's asar fs support);
at the time `node test.js` passed all 6 checks of that generation in the same shape (the
suite has since been rebuilt into the 8 groups listed under
[Verification](#verification), where the desktop-asar candidate is asserted structurally
in group H). After installing v1.1.3,
**restart the desktop app** and it works — no `DSH_INSTALL_PACKAGE_JSON` needed.

## Requirements

- **DeepSeek Harness ≥ 0.1.7 (including 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.1 /
  0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.2-rc.1)** desktop app
  (`dsh` CLI with the `dsh plugin` mechanism)
- **rtk with the `rtk rewrite` subcommand** on PATH (upstream reference hook states
  `Requires: rtk >= 0.23.0`; use the `RTK_BIN` environment variable to point at an
  alias or a non-PATH install). Contract verified against rtk 0.50.0, re-verified
  against 0.51.0 on 2026-10-03, and re-verified again against rtk 1.1.0 on 2026-11-08:
  exit-code semantics unchanged throughout.
- Windows + PowerShell (the plugin replaces the pwsh executor; bash/other shell
  tools are unaffected)

## rtk version compatibility

The plugin does not pin a narrow rtk window, because it consumes only the
`rtk rewrite` **process contract** (exit code + stdout) and never links against rtk
internals. That contract has been stable across every version probed:

| rtk version | Probed on | Result |
|-------------|-----------|--------|
| 0.50.0 | 2026-09-25 | exit 3 + stdout for a supported command, exit 1 + no output otherwise |
| 0.51.0 | 2026-10-03 | unchanged |
| 1.1.0 (this machine) | 2026-11-08 | unchanged; also the version the full command-family table above was measured on |

**Upstream `develop` runs ahead of the release line and that is not a compatibility
problem.** At the time of writing, upstream `develop` sits at tag `dev-1.2.0-rc.620`
while its own `Cargo.toml` still reads `0.49.0` and `CHANGELOG.md` stops at `0.49.0` —
three different numbering tracks (`dev-*` build tags, release-please version, and the
published installer version such as the local `1.1.0`). They are **not** comparable
semver, so "local 1.1.0 is behind 1.2.0-rc" is the wrong reading. What matters is
capability measured per command, and the local 1.1.0 already implements the full
contract (exit 3 semantics, identity pass-through, compound/pipeline rewriting,
`RTK_DISABLED=` prefix handling).

**Command coverage grows with rtk, not with this plugin.** Every rewrite rule lives
inside the rtk binary (native rules in `src/discover/rules.rs` plus 62 TOML filters in
`src/filters/`). Upgrading rtk therefore widens coverage with **no plugin update**: the
plugin forwards whatever rtk returns and holds no rule list of its own. Likewise, a
plugin upgrade cannot add coverage on its own.

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
  ├─ command already an rtk invocation ? ──► run as-is (recursion guard)
  ├─ rtk rewrite "<cmd>" (5s timeout)
  │    ├─ exit 0 + stdout ──► super.execute({...spec, command: rewritten})
  │    ├─ exit 3 + stdout ──► super.execute({...spec, command: rewritten})
  │    ├─ exit 1            ──► no rtk equivalent (pwsh cmdlets etc.), silently run as-is
  │    ├─ exit 2            ──► rtk deny rule matched, run as-is
  │    ├─ ENOENT            ──► rtk not on PATH, warn once then run as-is
  │    └─ timeout/other     ──► run as-is
  └─ super.execute(spec)   (SandboxPwshExecutor: sandbox confine wraps the rewritten command)
```

### Failure safety

Every rtk-side outcome other than "here is a rewritten command" ends in the original
command running unchanged. This plugin never blocks, never denies, and never degrades
the sandbox:

| Situation | What the plugin does |
|-----------|----------------------|
| rtk not installed / not on PATH (ENOENT) | warns **once** per process, then runs the original command |
| rtk has no equivalent (exit 1) | silent pass-through — this is the normal case for pwsh cmdlets (`Get-ChildItem`, `Write-Output`, `echo`, `env`) |
| rtk deny rule matched (exit 2) | pass-through; permission decisions belong to the host, not to this plugin |
| rtk hangs past the 5 s budget | warns, kills the child, runs the original command |
| rtk exits with a code upstream does not define, or crashes | stdout is discarded and the original command runs — an unrecognised code is never trusted as a rewrite |
| the rewrite result is byte-identical to the input | treated as "no change", original command runs (the comparison is the last-line guard) |
| `RTK_DISABLED=1` in the environment | no rewrite at all, original command runs |

Sandbox semantics are **not** affected by any of the rows above: only
`execute(spec)` is overridden, `resolve()` (the sandbox policy stamp) is untouched, and
the fallback path calls `super.execute(spec)` with the untouched spec.

Only the four codes rtk actually defines can produce a rewrite. 0 and 3 carry the
command on stdout and are adopted; 1 and 2 are silent pass-throughs; anything else logs
a warning and runs the original command.

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
  2026-10-03 and 1.1.0 on 2026-11-08): the four codes are
  **0 = rewrite printed and allow rules cover every command**, **1 = nothing printed,
  no rewrite**, **2 = a deny rule matched, nothing printed**, **3 = rewrite printed and
  an ask rule matched or the allow rules do not cover every command** (including the
  no-rules case). The `--help` text has been misread as "exits 0 whenever there is a
  rewrite"; it is a conditional clause. **On a machine with no Claude permission rules
  — the normal case for a DSH desktop install — every rewritable command exits 3 with
  the command on stdout**, so a plugin that only accepts exit 0 would rewrite nothing.
  Codes 0 and 3 both mean "here is your rewrite"; 1 and 2 both mean "keep the original".
  A command already in rtk form comes back unchanged under 0 or 3, which is why the
  plugin also compares the result against the input. Node's `execFile` surfaces the
  child exit code on `err.code` (a number), while spawn failures (ENOENT) put a string
  there, so all checks go through `Number(err.code)` — true on Node 24 and 26 alike.
- **Recursion guard**: the plugin never rewrites a command that is already an rtk
  invocation, so `rtk rewrite` output can be handed back without rtk being asked to
  rewrite itself. rtk's own marker for "already rewritten" is a bare `rtk ` first word
  — case-sensitive, no path form, no `.exe` form — so the guard has to recognise the
  wider set of shapes a command can arrive in (`rtk`, `rtk.exe`, `RTK.EXE`, an absolute
  path to the binary, a quoted first word, an `ENV=x` prefix, and the same shapes in a
  later segment of a compound command). The byte-identical comparison above is kept as
  the last line of defence regardless of how the command was recognised.
- **`RTK_DISABLED=1` is honored at the plugin's JS layer only** (index.js checks it
  before rewriting, which is why it is documented under [Disabling](#disabling) as this
  plugin's own switch). rtk's own `RTK_DISABLED` handling is different: it applies when
  the variable appears as an **env prefix inside the command text**
  (`RTK_DISABLED=1 git status`), where rtk exits 1 with a one-line stderr warning.
  Setting `RTK_DISABLED=1` as a **process environment variable** does not disable
  `rtk rewrite` — verified: `RTK_DISABLED=1 rtk rewrite "git status"` still prints
  `rtk git status` and exits 3.

## Install / Uninstall

**Prerequisite**: DSH desktop **0.2.0-rc.2+** bundles the `dsh` command — click
**"Manage dsh command"** in the desktop menu bar to install it; no separate
Node/pnpm needed.

**Install** (pin the exact version: `@latest` gets rolled back to an older release
by the release-age check):

```powershell
dsh plugin --profile desktop add dsh-pwsh-rtk-rewrite@1.1.7 --registry=https://registry.npmjs.org/
```

> Versions come from CI, which patch-bumps and publishes on every push to `main`,
> so the number above can trail the newest release. If the install fails with a
> 404, run `npm view dsh-pwsh-rtk-rewrite version` and pin that exact version instead.

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

- **Single command**: environment variable `RTK_DISABLED=1` — this is the plugin's own
  JS-layer switch, checked before the rewrite is attempted. Note the asymmetry
  documented above: rtk itself only honors `RTK_DISABLED=` when it appears as an env
  prefix **inside the command text**, not as a process environment variable.
- **Custom rtk binary**: `RTK_BIN=/path/to/rtk` (or `RTK_BIN=rtk.exe`) points the
  plugin at an rtk that is not on PATH — a different version, a nightly build, or a
  wrapper script. The plugin spawns exactly that path; no other configuration changes.
- **Whole line**: in the profile patch, override the `rtk-pwsh-shell` line with
  `disabled: true` and restore the `pwsh-sandbox` line with `disabled: false`

## Known limitations

These are properties of rtk's rewrite rules, not plugin defects. None of them affects
correctness — the original command always runs when there is no equivalent:

- **No rtk equivalent** for pwsh cmdlets and shell builtins (`Get-ChildItem`,
  `Get-Process`, `Write-Output`, `echo`, `env`, …). Exit 1, silent, no token savings.
- **No rewrite for `sudo …`** — rtk deliberately passes sudo'd commands through.
- **No rewrite of commands with a file redirect** (`git status > out.txt`) or a
  command substitution (`echo $(git status)`); rtk refuses constructs it cannot attest.
- **Some sub-invocations are narrower than the tool's own surface.** Examples measured
  on rtk 1.1.0: `npm test` and `pnpm test` are not rewritten (the rules cover
  `npm run/exec/x` and `pnpm run/exec/i/install/list/ls/outdated`, not the bare `test`
  script alias); `dotnet build` is rewritten but `dotnet test` is not; `vitest run`
  comes back as `rtk vitest` (the `run` word is absorbed by rtk). All of these are rtk
  behaviour, and all simply mean "original command runs".
- **`rtk rewrite` does not suppress identity rewrites.** A command already in rtk form
  comes back unchanged under exit 0/3; suppression is the caller's job, which is why
  the plugin compares the result against the input.
- **A `wc` stage in a pipeline is not rewritten** even though upstream
  `hooks/README.md` lists it as pipeline-safe; measured `ls | wc -l` → exit 1 on rtk
  1.1.0. Upstream documentation, not the plugin, is what trails reality here.

## Verification

```powershell
node test.js               # zero-dependency suite, 8 groups (check count grows as
                           # coverage is added; printed in the final tally line)
node test.js               #   A rewrite exit-code contract (injected fake rtk)
                           #   B rtk missing / warn-once
                           #   C recursion guard
                           #   D failure safety
                           #   E pure-function unit checks
                           #   F compound commands & pipelines (real rtk)
                           #   G command-family smoke (all 12 families, real rtk)
                           #   H module contract (exports, package.json, patch file)
```

The suite injects a **fake rtk** through `RTK_BIN` — a small `rewrite` script whose exit
code, stdout and timing are driven by `FAKE_SCENARIO` — so every contract branch is
exercised without depending on which rtk is installed, and a call log proves that the
recursion guard really skips spawning rtk. Groups F and G do call the **real** rtk
(absolute path) and use its current output as the oracle rather than hard-coding
expected strings, which is why they stay valid as rtk evolves. The host dependency
(`@deepseek-ai/dsh-pwsh-sandbox`) is stubbed through `DSH_INSTALL_PACKAGE_JSON`, so the
suite runs without `node_modules`.

Two environment variables exist for mutation testing:
`RTK_TEST_TARGET` points the suite at a mutated copy of `index.js`, and
`RTK_TEST_SOFT=1` downgrades "contract divergence but not blocking" findings from FAIL
to WARN.

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

To check coverage for a specific command before blaming the plugin, ask rtk directly —
this is exactly the call the plugin makes:

```powershell
rtk rewrite "git status"          # exit 3, prints: rtk git status
rtk rewrite "Get-ChildItem"       # exit 1, prints nothing
```

## File Layout

```
├── index.js          # RtkPwshExecutor (only source: isRtkInvocation + rtkRewrite + execute)
├── cordis.patch.yml  # bundle patch: disable pwsh-sandbox + insert rtk-pwsh-shell
├── package.json      # dsh.bundle.patch points at the patch file; no runtime dependencies
├── test.js           # zero-dependency verification suite (8 groups)
├── README.md         # English (this file)
└── README_zh.md      # 中文
```

## License

[MIT](LICENSE) © 2026 mengqi1436
