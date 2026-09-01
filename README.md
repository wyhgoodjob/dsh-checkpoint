# dsh-checkpoint

English | [中文](README.zh.md)

Git-snapshot **checkpoint/rollback** capability for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (`dsh`).

Roll a session back to a previous **completed turn**: in a git worktree it restores both the files and the conversation; in a non-git worktree it rolls back only the conversation and the UI says so.

> **Status: pre-implementation design, spike-first.** This README is the implementation hand-off: the decisions are made, the harness extension points are pinned, and the first task is a bounded spike. A new session can implement the plugin from this document alone — the master design doc (`dsh-main-loop-sisyphus-spec.md` §5 in the deepseek-harness checkout this was authored against) is optional background.

## Design (decided)

- **Capture granularity: per turn**, not per model step. One turn = one user interaction plus its agent work; rollback lands on completed `turn/end` boundaries. Per-step capture (opencode-style) is a later enhancement, explicitly out of MVP.
- **Storage: an isolated git object database** per session at `<data-dir>/checkpoint/<sessionId>/` (`git init` with `GIT_DIR`/`GIT_WORK_TREE`), holding **tree hashes only** — no commits, branches, or refs in the user's repo. When the workspace is already a git repo, seed the object DB from it via `objects/info/alternates` plus a copied index, so already-hashed blobs are reused (near-zero cost on large repos). Ignored files are skipped; untracked files above a size cap (default 2 MiB) are skipped.
- **Git detection with graceful degradation**: resolve a git worktree once per session (`git rev-parse --is-inside-work-tree`). Git repo → file+conversation rollback. Not a git repo (or no `git` binary) → conversation-only rollback, surfaced to the UI through a projection wire value.
- **Rollback = fork + reseed**, preserving the append-only session-log invariant: `ctx.sessions.fork(source, boundarySeq, childId)` cuts the log at the target turn's inclusive `turn/end` seq; the git layer restores files to the same boundary. There is no in-place truncation.
- **Staged revert**: before restoring, snapshot the current state once more, so the undo is itself undoable (opencode semantics).

## Interface contract

### Session events

Declared by module augmentation (plan-mode is the template — `packages/plan/plan-mode/src/index.ts` and `src/types.ts`):

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** log-only, non-surface, whole-value. One checkpoint per completed turn. */
    'checkpoint/captured': {
      turn: number
      treeHash: string | null   // null when the workspace is not a git repo
      changed: string[]         // paths changed during this turn
      isGitRepo: boolean
    }
    /** log-only, non-surface. One restore action. */
    'checkpoint/restored': {
      turn: number              // target turn rolled back to
      treeHash: string | null
      restored: string[]        // files actually restored (empty for context-only)
    }
  }
}
```

Plus an invariant companion (`src/invariant.ts`) validating both payloads, registered like plan-mode's.

### Projection

Register `{ key: 'checkpoints', stateSchema, init, apply, wire, stateVersion }` on `ctx.sessionProjections`. State folds `checkpoint/captured` into a per-turn index `{ turn, treeHash, changed }[]`. The `wire.view` exposes the rollback-point list and `{ isGitRepo }`, which flows to the web UI automatically (session-controller broadcasts projection updates) — this is the "not a git repo" hint channel.

### Tools

- `checkpoint_list` — args `{}`; result lists rollback points (turn number, changed-file count, timestamp) and `isGitRepo`.
- `checkpoint_restore` — args `{ turn: number }`; performs fork+reseed + file restore + pre-revert self-snapshot; result states what was restored and that later turns are no longer part of this conversation.

### Config

```ts
interface Config {
  untrackedFileMaxBytes?: number   // default 2 MiB
}
```

Plugin shape: function plugin, named exports `name` / `inject` / `Config` / `apply`, no default export (harness convention). Inject the services below.

## Pinned harness extension points (verified; do not re-research)

- **`agent/pre-step`** (waterfall, declared by `dsh-agent`, dispatched by `dsh-agent-loop`): `(payload { agent, messages, turn, step, signal }, next) => Promise<PreStepDecision>`. The canonical capture hook — call `await next()` first, then, only if `decision.kind === 'enter' && !signal.aborted`, run the capture and `agent.session.append(...)`. plan-mode (`packages/plan/plan-mode/src/index.ts`) is the reference implementation of exactly this pattern.
- **`Session.append`** (`packages/core/session/src/index.ts`) does **not** expose an `ignorable` parameter — this is the spike's whole subject. `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts`) is repo-static; external events not in it are required-on-read, so a first-party persistence load refuses a session carrying them unless the envelope says `ignorable: true`. Background: Agent Note `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md` in the harness checkout.
- **`ctx.sessions.fork(source, boundary?, childId?)`** — inclusive boundary seq; the selected prefix must end outside an open turn (else `OPEN_TURN`); error codes `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY | OPEN_TURN`. Child inherits `cwd`, stamps `parentSession`, sets `seedLength`.
- **Subprocess** — run git through `ctx.subprocess.spawn({ argv, cwd, ... })`; resolve the binary with `ctx.subprocess.resolveExecutable('git')` and degrade gracefully when it resolves to nothing. No `process.platform` branching anywhere.
- **Host services the plugin rows expect** (for the test composition — the real web profile supplies all of them): `shell`+`shellEnv` (from `bash-local`/`shell-env`), `fs` (`fs-local`), `subprocess` (`subprocess-local`), `web` (`dsh-web` + a provider), `userQuestions` (`dsh-user-questions`), `jobs` (`jobs-local`), `skills`, `subagents` (+ `spawn`/`fork` providers). Function plugins register as namespace modules, service classes as default exports.

## Task 0 — the ignorable spike (do this before everything)

Question: **can this plugin's live events carry `ignorable: true`?**

1. Read `Session.append` and the persistence layer (`packages/session/session-persistence`, the `PersistenceCoordinator` refusal path) in a deepseek-harness checkout. Determine whether any append/restore path accepts an `ignorable` marker for live events.
2. Either:
   - **A (preferred)**: a route exists — declare the checkpoint events informational, mark them ignorable, keep them in the session log.
   - **B**: no route exists — move the snapshot index into a plugin-owned side store (`ctx.storage`), keep only the restore action as a surface event, and update this README's Interface-contract section accordingly.
3. Write the answer into this README (replace this section) and proceed.

The decision is architectural, not cosmetic: option B changes where checkpoint state lives, which is why it gates all further code.

## Implementation order

1. Spike (§Task 0), record the outcome.
2. `src/git-snapshot.ts` — the isolated git object DB (init/track/restore/patch), including alternates seeding and the untracked size cap.
3. `src/index.ts` — the real function plugin: Config, service-inject list, git-worktree detection, `agent/pre-step` capture hook, event append.
4. `src/types.ts` + `src/invariant.ts` — event declarations and payload validation.
5. Projection registration + wire view.
6. `checkpoint_list` / `checkpoint_restore` tools + fork+reseed + staged restore.
7. Non-git degradation path (context-only rollback + projection hint).
8. Tests — a REAL-composition test (harness policy: product plugins need one; boot a test cordis.yml through the Loader) plus focused unit tests for the snapshot module (tmpdir-based, no network).
9. README (this file, kept current) + packaging cleanup.

## Acceptance criteria

- In a git worktree: run a turn that edits files, `checkpoint_restore` to the previous turn — files restored, conversation cut at that turn, and the restore itself undoable.
- In a non-git worktree: `checkpoint_list` reports context-only rollback; files untouched; the UI hint fires.
- Event payloads pass the invariant; the projection wire value reaches the client through session-controller.
- `checkpoint/captured` never breaks a first-party session reload (the spike's outcome made explicit).
- No `bin` entry; ESM-only; `@deepseek-ai/cordis` + every imported `@deepseek-ai/dsh-*` in `peerDependencies`.

## Developing against a harness checkout

The harness packages are not yet on a public registry cadence, so develop with a local checkout:

1. Clone `deepseek-harness`, `pnpm install && pnpm run build` (the build generates `lib/typert.*` artifacts the launch needs).
2. In this repo, add the harness packages you import as `devDependencies` via a `file:` or `link:` path (or a pnpm workspace overlay).
3. Validate exactly the way this design was validated for the sisyphus preset: a temporary vitest spec **inside the harness checkout** that boots the harness spine in-process with `ctx.baseUrl` pointed at `apps/cli`, mounts the plugin under test from this repo, and drives it — then delete the spec. (A boot test in this repo is the long-term home; the in-harness scratch spec is the fast iteration loop.) For a real-model smoke, load the key from the harness root `.env` and route `deepseek-official` / `deepseek-v4-flash`.

## Boundaries and non-goals

- Per-turn only (no per-step capture).
- Local git worktrees only; no filesystem-copy fallback (scheme C) for non-git workspaces or remote backends (e2b/subprocess).
- Conversation rollback always works; file rollback is explicitly best-effort and scoped to snapshotted files (ignored files, oversized untracked files, and shell side effects are never restored).

## License

MIT