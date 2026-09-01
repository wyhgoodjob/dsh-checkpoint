# dsh-checkpoint

Git-snapshot **checkpoint/rollback** capability for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (`dsh`).

Lets a user (or the model, through a tool) roll a session back to a previous **completed turn**: in a git worktree it restores both the files and the conversation; in a non-git worktree it rolls back only the conversation and the UI states so.

> Status: **scaffold**. The implementation lands after the `dsh-sisyphus` preset; the first coding task is the "ignorable spike" below.

## What it does

- Captures a git tree snapshot around each **turn** (one pre-turn and one post-turn) into a private git object database — no commits or branches in the user's repo.
- Exposes `checkpoint_list` (which turns can be restored) and `checkpoint_restore` (roll back to a chosen turn).
- Restore is a **staged revert**: it snapshots the current state first, so the undo is itself undoable.
- Detects whether the workspace is a git repo; if not, it degrades to conversation-only rollback and reports that through a session projection the UI can read.

## Design

The implementation rides existing dsh extension points; it changes no harness internals:

- **Capture timing** — one snapshot per turn, keyed off `turn/start` / `turn/end` (and `agent/pre-step` for the log-append pattern).
- **Git backend** — an isolated `git` object database per session (`<data-dir>/checkpoint/<sessionId>/`), tree hashes only, seeded from the workspace's own repo via `objects/info/alternates` when one exists.
- **Session log** — a `checkpoint/captured` event (per turn) and a `checkpoint/restored` event (per restore), declared by module augmentation on `@deepseek-ai/dsh-session/types`, folded by a `checkpoints` projection whose `wire` view drives the UI.
- **Rollback = fork + reseed** — `ctx.sessions.fork(source, boundarySeq, childId)` cuts the log at the target turn's `turn/end` (append-only invariant preserved); the git layer restores files to the same boundary.
- **Subprocess** — `git` runs through `ctx.subprocess.spawn`, resolved with `resolveExecutable('git')`; no `process.platform` branching, so Windows paths go through the existing subprocess seam.

### The ignorable spike (do this first)

External plugin events (`checkpoint/captured`, `checkpoint/restored`) are outside the repo-generated `KNOWN_SESSION_EVENT_TYPES`, so a first-party reload refuses a session containing them **unless the event envelope carries `ignorable: true`** — and the live `Session.append()` signature does not expose that marker (see the harness note `2026-08-30-retain-ignorable-external-session-events.md`).

Before writing the capture path, prove one of:

1. A route to append a live event with `ignorable: true` (e.g. the persistence-layer `append` accepting raw envelopes), with the checkpoint events marked informational; or
2. A side-store fallback: keep the snapshot index in a plugin-owned store (`ctx.storage`) outside the session log, and surface only the restore action through a tool result.

The conclusion decides whether `checkpoint/captured` becomes a session event or a side-store row. See `dsh-main-loop-sisyphus-spec.md` §5.4–§5.5 in the harness checkout for the full analysis.

## Install

```sh
dsh plugin --profile <name> add dsh-checkpoint
# or as a git dependency
dsh plugin --profile <name> add git+https://github.com/wyhgoodjob/dsh-checkpoint.git
```

Then mount it in the profile's `cordis.patch.yml` (or make it a bundle via a `"dsh": { "bundle": { "patch": ... } }` manifest).

## Requirements

- A DeepSeek Harness profile whose composition provides `ctx.subprocess`, `ctx.sessions`, `ctx.sessionProjections`, and `ctx.tools`.
- `git` on `PATH` for file-level restore; absent git degrades to conversation-only rollback.

## Know limits (planned)

- **Per-turn granularity** — not per-step (opencode captures per model step); a turn is the smallest rollback unit.
- **Local git worktrees only** — no filesystem-copy fallback for non-git workspaces or remote backends (e2b/subprocess).
- **Untracked files above a size cap and ignored files are not snapshotted** (mirrors opencode's bounds).

## License

MIT