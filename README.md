# codex-monitor

Watch and drive the **Codex desktop app** on your machine from the command line.

Codex runs long tasks in several windows at once. This tool answers three questions without
you switching between them: which sessions are still running, what each one is doing right now,
and — the one that actually bites — **which one is blocked waiting for your answer**.

It can also send work into any existing session, or start a new one.

## Why this exists

Codex's own status fields are not trustworthy for this:

- The desktop app persists an **in-flight turn as `interrupted`**, so `turn.status` says
  "stopped" while the agent is happily running.
- The `inProgress` flag in `thread_history_1.sqlite` **lags by minutes**.

Using either alone gives wrong answers. So liveness is decided by **activity heartbeat**: if
the session wrote a new item within the last 90 seconds, it is running. A pending question
takes priority over everything, because that means Codex has genuinely stopped.

## Requirements

- macOS with the Codex desktop app (or the `codex` CLI) installed and logged in
- Python 3.8+ (standard library only, no dependencies)

## Usage

```bash
python3 codex_ctl.py list                       # who is running, who is waiting
python3 codex_ctl.py status --thread ID         # what one session is stuck on
python3 codex_ctl.py watch                      # follow along, print only changes
python3 codex_ctl.py watch --once               # single snapshot
python3 codex_ctl.py send --thread ID --message "keep going" --wait 120
python3 codex_ctl.py new --cwd ~/proj --message "run the tests" --wait 300
```

`status --json` emits machine-readable output for scripting.

Sample `list` output:

```
本机 Codex 会话 6 个 · 正在跑 3 · 等你回复 1

▶ 正在跑      18:16  my-project          Refactor the auth middleware
                  id=01a1f73d-de97-7ca1-9831-e5973f9772cf
❓ 等你答      18:16  other-project       Port the settings page
                  ↳ Delete the stray record rec123, or keep it for testing?
                  id=01a1f73c-cd9d-76a3-be71-ad484f137417
```

## How it works

Two channels, because neither is sufficient alone:

| Channel | Source | Used for |
|---|---|---|
| Control | `codex app-server` over JSON-RPC stdio | listing sessions, sending turns, turn status |
| Telemetry | `~/.codex/thread_history_1.sqlite` | live actions: commands run, files changed, sub-agents, heartbeat |

Both read the same `~/.codex` store the desktop app uses, so what you see here is what you see
in the Codex window.

### Why not `codex app-server proxy`

`proxy` attaches to the shared daemon, but it fails with `Broken pipe` when the CLI and the
desktop app bundle different Codex versions (e.g. CLI 0.167 vs. bundled 0.171). So each
invocation spawns its own `app-server --listen stdio://` process. It shares the same store and
can append to the same thread; the cost is roughly 2 seconds of startup per call.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

The suite builds throwaway SQLite fixtures shaped like Codex's own tables and covers the
liveness rules, question detection, and item parsing. It never launches Codex.

## Known limits

- `send` **appends a turn**; it does not interrupt a running one. Messages queue behind it.
- Read and dispatch only. Sessions are never deleted and Codex config is never modified.
- It will not answer Codex's questions for you — options are surfaced, you decide.
- Status reflects Codex's local store; sessions driven from another machine's daemon will not
  appear.

## Using it as a DSH skill

The `SKILL.md` in this repo registers it as a [DeepSeek Harness](https://github.com/deepseek-ai)
skill so an agent can call it directly. Copy the directory to `~/.agents/skills/codex-monitor/`.

## License

MIT
