# Testing dsh-checkpoint locally

A fast manual pass over the checkpoint plugin, in two levels: standalone unit tests (no harness needed) and a real-profile tryout (needs a built DeepSeek Harness checkout).

## 1. Standalone: unit tests

The git-snapshot core unit-tests against a real `git` binary; the harness is not involved.

```sh
git clone https://github.com/wyhgoodjob/dsh-checkpoint.git
cd dsh-checkpoint
pnpm install
pnpm test          # 4 tests: track/patch/restore round-trip, empty-tree clear, seeding, oversized-untracked skip
```

Requires `git` on `PATH`. `pnpm install` approves the esbuild build via `pnpm-workspace.yaml`; on older pnpm versions you may be asked to `pnpm approve-builds` once.

## 2. Build the plugin

The build resolves harness types through `tsconfig.json` paths that point at a sibling checkout, so the harness must be cloned next to this repo and built once:

```sh
cd ..                       # this repo and deepseek-harness live side by side
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install && pnpm run build
cd ../dsh-checkpoint
pnpm build                  # emits lib/index.js + lib/git-snapshot.js
```

The emitted plugin has exactly one runtime peer (`@deepseek-ai/dsh-tools`), which the dsh profile resolves from its own installation.

## 3. Try it in a real profile

Install the built local package into a profile and mount it:

```sh
cd ~/deepseek-harness
dsh plugin --profile web add file:../dsh-checkpoint
```

Then add the row to the profile's patch layer (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- name: dsh-checkpoint
```

Restart dsh (`pnpm dsh web`, or your usual launch) and run a session whose workspace is a **git repository**:

1. Ask the model to make a small file change (write a scratch file, tweak a comment).
2. Ask it to call `checkpoint_list` — expect rollback points listing the completed turns with changed-file counts.
3. Ask it to call `checkpoint_restore` with an earlier turn — expect the changed files to revert (created files disappear) and the result to name a forked child session.
4. The restore snapshots the pre-revert state first, so `checkpoint_restore` on the reported undo point reverts the revert.

In a **non-git** workspace the same flow works conversation-only: `checkpoint_list` reports `isGitRepo: false`, `checkpoint_restore` forks the conversation and reports `contextOnly: true` without touching files.

State lives under `~/.dsh/checkpoint/checkpoint/<sessionId>/` — an isolated git object database plus `index.json`. Your repo's own git history is never touched (no commits, branches, or refs).

## Uninstall

```sh
dsh plugin --profile web remove dsh-checkpoint
# remove the row from ~/.dsh/profiles/web/cordis.patch.yml and restart dsh
# optional: rm -rf ~/.dsh/checkpoint        # captured snapshots
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pnpm build` fails with module-not-found under `@deepseek-ai/...` | the sibling `deepseek-harness` checkout is missing or not built (`pnpm install && pnpm run build` there first) |
| `checkpoint_restore` says no checkpoint for that turn | captures land at `turn/end`; wait for the turn to finish, or check `checkpoint_list` for available turns |
| `checkpoint_list` reports `isGitRepo: false` in a git repo | the session workspace is not the git worktree root, or `git` is missing from `PATH` |
| Plugin row fails to load in the profile | the package was installed before `pnpm build` (no `lib/`); rebuild and reinstall |
| Windows | `git` must be on `PATH`; the plugin runs it through the harness subprocess seam, so no special flags are needed |

## About the automated checks

The repo-local vitest suite covers `git-snapshot.ts` only. `tests/harness-checkpoint.spec.ts` is the real-composition smoke (git capture + restore + fork, non-git degradation); it imports harness packages and a scratch copy of the plugin source, so it runs inside a deepseek-harness checkout — see the instructions in its header.

## License

MIT