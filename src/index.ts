/**
 * dsh-checkpoint — git-snapshot checkpoint/rollback capability.
 *
 * NOTE: implementation scaffold. The exact service injection names, tool
 * registration shape, and event-append path are pinned during the first
 * coding pass (the "ignorable spike" named in README.md). Do not treat the
 * bodies below as final API — they record the plan against the harness
 * extension points researched in dsh-main-loop-sisyphus-spec.md.
 */

// The function-plugin export shape (per harness packages/AGENTS.md):
// named exports `name` / `inject` / `Config` / `apply`, no default export.

export const name = 'checkpoint'

// Services the smoke-test composition must supply. Final list pinned during
// the spike; the likely set:
//   'subprocess'          -> ctx.subprocess.spawn (run git)
//   'sessions'            -> ctx.sessions.fork    (rollback = fork + reseed)
//   'sessionProjections'  -> ctx.sessionProjections.register (checkpoint index -> UI)
//   'tools'               -> ctx.tools.register   (checkpoint_list / checkpoint_restore)
export const inject = ['subprocess'] as string[]

export interface Config {
  /** Skip-the-capture file size cap for untracked files (bytes). */
  untrackedFileMaxBytes?: number
}

/** Plugin config schema (mirrors the harness Config-as-Zod convention). */
export function defineConfig(_defaults: Config): Config {
  return _defaults
}

/**
 * apply(ctx, config): the plugin body.
 *
 * Planned wiring (see README.md and the spec's §5):
 *   1. Detect git worktree once per session (resolveExecutable('git') + `git rev-parse`).
 *   2. If git: snapshot a pre-turn tree at `turn/start`, post-turn at `turn/end`.
 *   3. Append `checkpoint/captured` (or a side-store row, per the ignorable spike).
 *   4. Register `checkpoint_list` and `checkpoint_restore` tools.
 *   5. `checkpoint_restore` = fork at the target turn/end + git restore + pre-revert
 *      self-snapshot (staged revert).
 */
export function apply(_ctx: unknown, _config: Config): void {
  // Implemented after sisyphus. Placeholder to make the package importable.
}