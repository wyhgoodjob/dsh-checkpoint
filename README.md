# dsh-checkpoint

English | [中文](README.zh.md)

Git-snapshot **checkpoint/rollback** capability for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (`dsh`).

Roll a session back to a previous **completed turn**: in a git worktree it restores both the files and the conversation; in a non-git worktree it rolls back only the conversation and the tool result says so.

> **Status: spike resolved, implementing.** The Task 0 spike is complete with outcome **B**; the interface contract below is the post-spike design. This README is the authoritative hand-off document.

## Design (decided)

- **Capture granularity: per turn**, not per model step. One turn = one user interaction plus its agent work; rollback lands on completed `turn/end` boundaries. Per-step capture (opencode-style) is a later enhancement, explicitly out of MVP.
- **Storage: an isolated git object database** per session at `<dataDir>/checkpoint/<sessionId>/git/` (`git init` with `GIT_DIR`/`GIT_WORK_TREE`), holding **tree hashes only** — no commits, branches, or refs in the user's repo. When the workspace is already a git repo, seed the object DB from it via `objects/info/alternates` plus a copied index, so already-hashed blobs are reused (near-zero cost on large repos). Ignored files are skipped; untracked files above a size cap (default 2 MiB) are skipped.
- **Snapshot index is a plugin-owned file** at `<dataDir>/checkpoint/<sessionId>/index.json` (one record per turn: turn, tree hash, changed paths, timestamp). See §Task 0 for why the index does not live in the session log.
- **Git detection with graceful degradation**: resolve a git worktree once per session (`git rev-parse --is-inside-work-tree`). Git repo → file+conversation rollback. Not a git repo (or no `git` binary) → conversation-only rollback; `checkpoint_list` reports `isGitRepo: false` and `checkpoint_restore` refuses file restore.
- **Rollback = fork + reseed**, preserving the append-only session-log invariant: `ctx.sessions.fork(source, boundarySeq, childId)` cuts the log at the target turn's inclusive `turn/end` seq; the git layer restores files to the same boundary. There is no in-place truncation.
- **Staged revert**: before restoring, snapshot the current state once more, so the undo is itself undoable (opencode semantics).

## Task 0 — spike outcome (option B)

Question: **can this plugin's live events carry `ignorable: true`?** Answer: **no**.

- `Session.append` (`packages/core/session/src/index.ts`) builds the envelope from `{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }` only; `SurfaceIntent` has no further fields. The live path has no channel for the marker.
- The persistence read path (`session-persistence/src/coordinator.ts`, the unknown-type guard) refuses any event type outside `KNOWN_SESSION_EVENT_TYPES` unless the persisted envelope carries `ignorable: true`.
- No producer in the harness writes `ignorable: true`; the seed/restore envelope validator accepts the key, but live production cannot reach it.

Consequence: the plugin appends **no custom session events**. The snapshot index is a plugin-owned file; model visibility rides on the two tools, whose `tool/call`/`tool/result` are known event types (reload-safe). If the harness later opens an ignorable path for live appends, the plugin can migrate back to logged `checkpoint/captured` events plus a projection — do not re-add events before that.

## Interface contract

### Side-store index (`<dataDir>/checkpoint/<sessionId>/index.json`)

```ts
interface CheckpointRecord {
  turn: number
  treeHash: string | null   // null when the workspace is not a git repo
  changed: string[]         // paths changed during this turn
  capturedAt: number        // epoch ms
}
```

### Tools

- `checkpoint_list` — args `{}`; result: `{ isGitRepo: boolean, points: { turn, changedCount, capturedAt }[] }`.
- `checkpoint_restore` — args `{ turn: number }`; performs fork+reseed + file restore + pre-revert self-snapshot; result: `{ restored: string[], childSessionId?: string, contextOnly: boolean }`. In a non-git worktree, `restored` is empty and `contextOnly: true`.

### Config

```ts
interface Config {
  dataDir?: string               // default: <dsh home>/checkpoint
  untrackedFileMaxBytes?: number // default 2 MiB
}
```

Plugin shape: function plugin, named exports `name` / `inject` / `Config` / `apply`, no default export (harness convention). Injects `subprocess`, `sessions`, `tools`.

## Pinned harness extension points (verified; do not re-research)

- **`agent/pre-step`** and the **`session/event` feed** are the capture triggers — the plugin only READS them; it appends nothing. Listen for `turn/start` (capture pre-tree) and `turn/end` (capture post-tree + patch). The session's workspace is `session.header.cwd` (durable).
- **`ctx.sessions.fork(source, boundary?, childId?)`** — inclusive boundary seq; the selected prefix must end outside an open turn (else `OPEN_TURN`); error codes `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY | OPEN_TURN`. Child inherits `cwd`, stamps `parentSession`, sets `seedLength`.
- **Subprocess** — run git through `ctx.subprocess.spawn({ argv, cwd, ... })`; resolve the binary with `ctx.subprocess.resolveExecutable('git')` and degrade gracefully when it resolves to nothing. No `process.platform` branching anywhere.
- **Host services the plugin expects in a test composition** (the real web profile supplies all of them): `sessions`, `subprocess` (`subprocess-local`), `tools`; a full-session smoke additionally needs the subagent stack, `shell`/`shellEnv`, `fs`, `web`, `userQuestions`, `jobs`, `skills` — mirroring any preset-driven session.

## Implementation order

1. ✅ Spike (§Task 0) — outcome B recorded.
2. `src/git-snapshot.ts` — the isolated git object DB (init/track/restore/patch), alternates seeding, untracked size cap. Unit-tested against a real `git` binary in a tmpdir.
3. `src/index.ts` — the function plugin: Config, git-worktree detection per session, capture hooks, index.json management, the two tools, fork+reseed + staged restore.
4. Tests — unit (git-snapshot) plus a real-composition smoke inside a harness checkout (boot the spine, run a turn that edits files, restore, assert files revert).
5. README (this file, kept current) + packaging cleanup.

## Acceptance criteria

- In a git worktree: run a turn that edits files, `checkpoint_restore` to the previous turn — files restored, conversation cut at that turn, and the restore itself undoable.
- In a non-git worktree: `checkpoint_list` reports `isGitRepo: false`; `checkpoint_restore` rolls back conversation only and reports `contextOnly: true`; files untouched.
- Sessions carrying checkpoint activity reload cleanly in a first-party build (no custom events in the log).
- No `bin` entry; ESM-only; `@deepseek-ai/cordis` + every imported `@deepseek-ai/dsh-*` in `peerDependencies`.

## Developing against a harness checkout

The harness packages are not yet on a stable public registry cadence, so develop with a local checkout:

1. Clone `deepseek-harness` next to this repo, `pnpm install && pnpm run build` (the build generates `lib/typert.*` artifacts the launch needs).
2. In this repo, add the harness packages you import as `devDependencies` via `file:` paths (e.g. `file:../deepseek-harness/packages/core/session`).
3. Fast iteration: a temporary vitest spec inside the harness checkout that boots the harness spine in-process with `ctx.baseUrl` pointed at `apps/cli`, mounts the plugin under test from this repo, and drives it — then delete the spec. A real-composition boot test in this repo is the long-term home.

## Boundaries and non-goals

- Per-turn only (no per-step capture).
- Local git worktrees only; no filesystem-copy fallback (scheme C) for non-git workspaces or remote backends (e2b/subprocess).
- Conversation rollback always works; file rollback is explicitly best-effort and scoped to snapshotted files (ignored files, oversized untracked files, and shell side effects are never restored).

## License

MIT