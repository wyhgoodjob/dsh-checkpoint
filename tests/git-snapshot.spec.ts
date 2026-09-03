import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_TREE, GitSnapshotStore, type CommandRunner } from '../src/git-snapshot.ts'

function makeRunner(gitPath: string): CommandRunner {
  return {
    run(args, cwd, env) {
      return new Promise((resolve, reject) => {
        execFile(gitPath, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
          if (error) {
            if (typeof (error as NodeJS.ErrnoException).code === 'number') {
              resolve({ code: (error as NodeJS.ErrnoException).code as number, stdout, stderr })
            } else {
              reject(error)
            }
            return
          }
          resolve({ code: 0, stdout, stderr })
        })
      })
    },
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function findGit(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--version'], (error, stdout) => {
      if (error) reject(new Error('git binary unavailable'))
      else resolve('git')
    })
  })
}

describe('GitSnapshotStore', () => {
  it('captures the empty tree for a missing worktree', async () => {
    const gitPath = await findGit()
    const base = tempDir('dsh-checkpoint-empty-')
    const store = new GitSnapshotStore(makeRunner(gitPath), {
      gitDir: join(base, 'snap'),
      workTree: join(base, 'worktree'),
      untrackedFileMaxBytes: 2 << 20,
    })
    expect(await store.track()).toBe(EMPTY_TREE)
    rmSync(base, { recursive: true, force: true })
  })

  it('tracks, patches, and restores file changes', async () => {
    const gitPath = await findGit()
    const base = tempDir('dsh-checkpoint-roundtrip-')
    const workTree = join(base, 'worktree')
    mkdirSync(workTree, { recursive: true })
    const store = new GitSnapshotStore(makeRunner(gitPath), {
      gitDir: join(base, 'snap'),
      workTree,
      untrackedFileMaxBytes: 2 << 20,
    })

    const empty = await store.track()
    expect(empty).toBe(EMPTY_TREE)

    writeFileSync(join(workTree, 'a.txt'), 'first')
    const first = await store.track()
    expect(first).not.toBe(EMPTY_TREE)
    expect(await store.patch(empty, first)).toEqual(['a.txt'])

    writeFileSync(join(workTree, 'a.txt'), 'second')
    writeFileSync(join(workTree, 'b.txt'), 'born')
    const second = await store.track()
    expect(await store.patch(first, second).then(list => list.sort())).toEqual(['a.txt', 'b.txt'])

    const deleted = await store.restore(first, second)
    expect(deleted).toEqual(['b.txt'])
    expect(readFileSync(join(workTree, 'a.txt'), 'utf8')).toBe('first')
    expect(() => readFileSync(join(workTree, 'b.txt'))).toThrow()
    rmSync(base, { recursive: true, force: true })
  })

  it('restoring to the empty tree clears the worktree', async () => {
    const gitPath = await findGit()
    const base = tempDir('dsh-checkpoint-clear-')
    const workTree = join(base, 'worktree')
    mkdirSync(workTree, { recursive: true })
    const store = new GitSnapshotStore(makeRunner(gitPath), {
      gitDir: join(base, 'snap'),
      workTree,
      untrackedFileMaxBytes: 2 << 20,
    })

    writeFileSync(join(workTree, 'c.txt'), 'content')
    const has = await store.track()
    const deleted = await store.restore(EMPTY_TREE, has)
    expect(deleted).toEqual(['c.txt'])
    expect(existsSync(join(workTree, 'c.txt'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('skips oversized untracked files and reuses seeded blobs', async () => {
    const gitPath = await findGit()
    const base = tempDir('dsh-checkpoint-seed-')
    const workTree = join(base, 'worktree')
    mkdirSync(workTree, { recursive: true })

    const source = new GitSnapshotStore(makeRunner(gitPath), {
      gitDir: join(base, 'source'),
      workTree,
      untrackedFileMaxBytes: 2 << 20,
    })
    writeFileSync(join(workTree, 'keep.txt'), 'keep me')
    await source.init()
    const seededHash = await source.track()

    const big = Buffer.alloc((2 << 20) + 1, 0x61)
    writeFileSync(join(workTree, 'big.bin'), big)

    const seeded = new GitSnapshotStore(makeRunner(gitPath), {
      gitDir: join(base, 'seeded'),
      workTree,
      untrackedFileMaxBytes: 2 << 20,
      seed: { objectsDir: join(base, 'source', 'objects'), indexFile: join(base, 'source', 'index') },
    })
    const captured = await seeded.track()
    expect(await seeded.patch(EMPTY_TREE, captured)).toEqual(['keep.txt'])
    expect(captured).toBe(seededHash)
    rmSync(base, { recursive: true, force: true })
  })
})
