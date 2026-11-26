# pi-orca-process-wait

[简体中文](README.md) | **English**

A lightweight [Pi](https://pi.dev) extension that bridges [`@aliou/pi-processes`](https://github.com/aliou/pi-processes) background tasks into **Orca**'s existing agent-status and session-liveness channels.

It prevents **Orca Orchestration** from mistaking Pi's end-of-turn (while waiting for a background `process` command) for a stopped worker.

---

## Problem

When Orca dispatches a task to Pi and Pi starts a long-running command via `process start` (tests, builds, training jobs, etc.) and ends its turn to wait for the exit wake-up:

- **Before**:
  1. Orca cannot see `@aliou/pi-processes` background jobs, so on `agent_end` / `agent_settled` it marks Pi as `idle / done` (the spinner stops in the UI).
  2. Orca Orchestration immediately sends a premature `Worker stopped without reporting` escalation to the coordinator.
  3. Later, when the command exits, Pi wakes up for a second turn and sends the real `worker_done`.
- **After**:
  1. While the background command runs, Orca keeps Pi active (spinner stays active and `pi-process:<id>` appears in child work).
  2. Premature `Worker stopped without reporting` notifications are suppressed until the process finishes and Pi completes its wake turn.
  3. In Orca Native Chat (`pi --mode rpc`), the bridge also registers an active provider on `Symbol.for('@agegr/pi-web/session-liveness/v1')` so idle-eviction probes do not terminate the Pi child process during long runs.

---

## Requirements

- **Pi** `>= 1.4.0` (verified on Pi `1.6.0`)
- **`@aliou/pi-processes`** `>= 0.13.6` (exposes `wake` conditions on `processes:request:list`)
- **Orca** (with its managed `~/.pi/agent/extensions/orca-agent-status.ts` and `~/.orca/pi-native-chat/orca-background-work.ts`)
- **No Orca rebuild required**; works with both **Terminal Pi** and **Native Chat Pi** workers.

---

## Installation

Choose either method below:

### Option 1: Install as a Pi package (recommended)

```bash
pi install git:github.com/xing-shuai/pi-orca-process-wait
```

Or add it to `packages` in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:@aliou/pi-processes@0.13.6",
    "git:github.com/xing-shuai/pi-orca-process-wait"
  ]
}
```

### Option 2: Copy the single extension file

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL \
  https://raw.githubusercontent.com/xing-shuai/pi-orca-process-wait/main/extensions/orca-process-wait-bridge.ts \
  -o ~/.pi/agent/extensions/orca-process-wait-bridge.ts
```

New Pi sessions pick it up automatically. For an already-running Pi session, run `/reload`.

---

## Behavior & Tracking Rules

Zero configuration is required:

1. **Orca-only activation**: Activates only when an Orca environment variable (`ORCA_PANE_KEY`, `ORCA_STRUCTURED_SESSION`, `ORCA_PI_BACKGROUND_WORK_DIR`, or `ORCA_AGENT_HOOK_ENDPOINT`) is present. Inert outside Orca, in OMP, and in `pi-subagents` child processes.
2. **Tracked processes** (via `processes:request:list` `wake` metadata):
   - Live processes (`running`, `terminating`, `terminate_timeout`) with `wake.exitAttention.success === "turn"` (default for one-shot commands), OR
   - Live processes with an unfired one-shot `turn` log watch (`on === "turn" && !repeat && !fired`), releasing automatically once the watch fires.
3. **Not held open**:
   - Persistent servers configured with `notify.onSuccess: "context"` or `"ignore"` (even if `onFailure: "turn"` or repeating error watches are enabled).
   - Processes killed externally or stopped intentionally without triggering a wake turn: released cleanly after a 500 ms wake grace window so Orca never hangs.

---

## Known Limitations

Because this extension works without patching Orca itself by reusing Orca's existing child-work channel (`subagent:async-started` / `subagent:async-complete`):

1. Orca displays the state as `working` (with child entry `pi-process:<id>`) rather than Orca's native `monitoring` ("Monitoring background tasks") label.
2. Orca's native 20-minute `background-wait` coordinator reminder does not fire; the session remains `working` while a tracked process is alive (and settles immediately if the process exits, crashes, or is killed).

---

## Testing

```bash
npm test
```

Runs 11 tests covering Terminal and Native Chat integration against Orca's real managed extensions, persistent server filtering, readiness watches, startup/tool-result races, reload/session-switch cleanup, and a real `pi --mode rpc` smoke test with `@aliou/pi-processes`.

---

## License

[MIT](LICENSE)
