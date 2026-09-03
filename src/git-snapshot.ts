/**
 * Isolated git object database for checkpoint snapshots — tree hashes only,
 * no commits, branches, or refs in the user's repo. Harness-free: the caller
 * supplies a {@link CommandRunner} (the plugin adapts `ctx.subprocess`; tests
 * adapt `child_process`), so this module unit-tests against a real git binary.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(args: string[], cwd: string, env: Record<string, string>): Promise<RunResult>
}

export interface GitSnapshotOptions {
  /** Isolated git directory (created on init). */
  gitDir: string
  /** Worktree root the snapshots cover. */
  workTree: string
  /** Untracked files at or above this byte size are excluded from capture. */
  untrackedFileMaxBytes: number
  /**
   * Optional seeding from the workspace's own git repo: blob reuse through
   * `objects/info/alternates` plus a copied index, so unchanged files keep
   * their hashes instead of being re-hashed on every capture.
   */
  seed?: {
    objectsDir: string
    indexFile: string
  }
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export class GitSnapshotError extends Error {}

export class GitSnapshotStore {
  private readonly excludes = new Set<string>()
  private inited = false

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: GitSnapshotOptions,
  ) {}

  private env(): Record<string, string> {
    return {
      GIT_DIR: this.options.gitDir,
      GIT_WORK_TREE: this.options.workTree,
      GIT_INDEX_FILE: join(this.options.gitDir, 'index'),
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    }
  }

  private async run(args: string[]): Promise<RunResult> {
    const cwd = existsSync(this.options.workTree) ? this.options.workTree : this.options.gitDir
    return this.runner.run(args, cwd, this.env())
  }

  private async requireGit(args: string[]): Promise<RunResult> {
    const result = await this.run(args)
    if (result.code !== 0) {
      throw new GitSnapshotError(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
    }
    return result
  }

  /** Create the isolated git dir, seed it, and initialize the repo. */
  async init(): Promise<void> {
    if (this.inited) return
    mkdirSync(join(this.options.gitDir, 'objects', 'info'), { recursive: true })
    if (this.options.seed !== undefined) {
      const alternates = join(this.options.gitDir, 'objects', 'info', 'alternates')
      if (!existsSync(alternates)) {
        writeFileSync(alternates, `${this.options.seed.objectsDir}\n`)
      }
      const indexFile = join(this.options.gitDir, 'index')
      if (!existsSync(indexFile) && existsSync(this.options.seed.indexFile)) {
        writeFileSync(indexFile, readFileSync(this.options.seed.indexFile))
      }
    }
    await this.requireGit(['init', '--quiet'])
    this.inited = true
  }

  /**
   * Stage the whole worktree (minus ignored and oversized untracked files)
   * and return the resulting tree hash. A missing worktree captures the empty
   * tree.
   */
  async track(): Promise<string> {
    await this.init()
    if (!existsSync(this.options.workTree)) return EMPTY_TREE
    await this.excludeOversizedUntracked()
    await this.requireGit(['add', '--all'])
    const result = await this.requireGit(['write-tree'])
    return result.stdout.trim()
  }

  /** Paths changed between two trees (added, deleted, or modified). */
  async patch(fromHash: string, toHash: string): Promise<string[]> {
    await this.init()
    const result = await this.requireGit(['diff-tree', '--name-only', '-r', fromHash, toHash])
    return result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  }

  /**
   * Restore the worktree to a tree hash. Deletes files present after
   * `restoreFromHash` but absent in the target (tracked or untracked since
   * then) and rewrites every surviving file from the target tree. Returns the
   * deleted paths.
   */
  async restore(targetHash: string, restoreFromHash: string): Promise<string[]> {
    await this.init()
    const deleted = new Set<string>()

    const deletedTracked = await this.run(['diff-tree', '--diff-filter=D', '--name-only', '-r', restoreFromHash, targetHash])
    if (deletedTracked.code !== 0) throw new GitSnapshotError(`git diff-tree failed: ${deletedTracked.stderr.trim()}`)
    for (const path of deletedTracked.stdout.split('\n')) {
      const trimmed = path.trim()
      if (trimmed.length > 0) deleted.add(trimmed)
    }

    const untracked = await this.run(['ls-files', '--others', '--exclude-standard', '-z'])
    if (untracked.code !== 0) throw new GitSnapshotError(`git ls-files failed: ${untracked.stderr.trim()}`)
    for (const path of untracked.stdout.split('\0')) {
      if (path.length > 0) deleted.add(path)
    }

    for (const path of deleted) {
      rmSync(join(this.options.workTree, path), { recursive: true, force: true })
    }

    await this.requireGit(['read-tree', targetHash])
    await this.requireGit(['checkout-index', '-a', '-f'])
    return [...deleted]
  }

  /** Append oversized untracked files to `info/exclude` so captures skip them. */
  private async excludeOversizedUntracked(): Promise<void> {
    const listing = await this.run(['ls-files', '--others', '--exclude-standard', '-z'])
    if (listing.code !== 0) throw new GitSnapshotError(`git ls-files failed: ${listing.stderr.trim()}`)
    const maxBytes = this.options.untrackedFileMaxBytes
    for (const path of listing.stdout.split('\0')) {
      if (path.length === 0) continue
      const absolute = join(this.options.workTree, path)
      try {
        if (statSync(absolute).size < maxBytes) continue
      } catch {
        continue
      }
      if (!this.excludes.has(path)) {
        this.excludes.add(path)
        writeFileSync(join(this.options.gitDir, 'info', 'exclude'), `# checkpoint capture exclusions\n`, { flag: 'a' })
        writeFileSync(join(this.options.gitDir, 'info', 'exclude'), `${path}\n`, { flag: 'a' })
      }
    }
  }
}
