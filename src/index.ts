/**
 * dsh-checkpoint — git-snapshot checkpoint/rollback capability.
 *
 * Per the Task 0 spike outcome (option B), this plugin appends no custom
 * session events: the snapshot index is a plugin-owned file, and model
 * visibility rides on the two tools. Capture is driven by the session event
 * feed (read-only): `turn/start` records the pre-turn tree, `turn/end`
 * records the post-turn tree plus the changed-path patch.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  EMPTY_TREE,
  GitSnapshotStore,
  type CommandRunner,
} from './git-snapshot.ts'

export const name = 'checkpoint'
export const inject = ['subprocess', 'sessions', 'tools'] as const

export interface Config {
  /** Root for checkpoint state; defaults to `<home>/.dsh/checkpoint`. */
  dataDir?: string
  /** Untracked files at or above this byte size are excluded from capture. */
  untrackedFileMaxBytes?: number
}

interface CheckpointRecord {
  turn: number
  treeHash: string | null
  changed: string[]
  capturedAt: number
}

interface SessionState {
  sessionId: string
  cwd: string
  isGitRepo: boolean
  store: GitSnapshotStore | null
  index: CheckpointRecord[]
  pendingPre: string | null
  lastTracked: string
  chain: Promise<unknown>
}

function findTurnEndSeq(session: Session, turn: number): number | undefined {
  for (const event of session.events) {
    if (event.type === 'turn/end' && event.data.turn === turn) return event.seq
  }
  return undefined
}

function latestTurn(session: Session): number {
  let latest = 0
  for (const event of session.events) {
    if (event.type === 'turn/end' && event.data.turn > latest) latest = event.data.turn
  }
  return latest
}

export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir ?? join(homedir(), '.dsh', 'checkpoint')
  const untrackedFileMaxBytes = config.untrackedFileMaxBytes ?? 2 * 1024 * 1024
  if (!Number.isFinite(untrackedFileMaxBytes) || untrackedFileMaxBytes <= 0) {
    throw new Error('checkpoint: untrackedFileMaxBytes must be a positive finite number')
  }
  const subprocess = ctx.subprocess
  const gitPathPromise: Promise<string | undefined> = subprocess.resolveExecutable('git')
  const gitPath = (): Promise<string | undefined> => gitPathPromise

  const runnerFor = (git: string): CommandRunner => ({
    run: async (args, cwd, env) => {
      const handle = subprocess.spawn({
        argv: [git, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4 << 20, spill: { maxBytes: 64 << 20 } },
          stderr: { maxBytes: 1 << 20 },
        },
        graceMs: 10_000,
        env,
      })
      const outcome = await handle.done
      return {
        code: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  })

  const plainRun = (git: string, args: string[], cwd: string) =>
    runnerFor(git).run(args, cwd, {})

  const states = new Map<string, SessionState>()

  const stateDir = (id: string): string => join(dataDir, 'checkpoint', id)
  const indexFile = (id: string): string => join(stateDir(id), 'index.json')

  function loadIndex(id: string): CheckpointRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(indexFile(id), 'utf8'))
      if (Array.isArray(parsed)) return parsed as CheckpointRecord[]
    } catch {
      // missing or corrupt index starts empty; captures rebuild it
    }
    return []
  }

  function persistIndex(state: SessionState): void {
    const file = indexFile(state.sessionId)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(state.index))
  }

  async function buildState(session: Session): Promise<SessionState> {
    const id = String(session.id)
    const cwd = session.header.cwd ?? ''
    const base: SessionState = {
      sessionId: id,
      cwd,
      isGitRepo: false,
      store: null,
      index: loadIndex(id),
      pendingPre: null,
      lastTracked: EMPTY_TREE,
      chain: Promise.resolve(),
    }
    if (cwd.length === 0) return base
    const git = await gitPath()
    if (git === undefined) return base

    const probe = await plainRun(git, ['rev-parse', '--is-inside-work-tree'], cwd)
    if (probe.code !== 0 || probe.stdout.trim() !== 'true') return base

    const gitDirResult = await plainRun(git, ['rev-parse', '--absolute-git-dir'], cwd)
    const indexResult = await plainRun(git, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], cwd)
    const sourceGitDir = gitDirResult.code === 0 ? gitDirResult.stdout.trim() : ''
    const sourceIndex = indexResult.code === 0 ? indexResult.stdout.trim() : ''
    if (sourceGitDir.length === 0 || sourceIndex.length === 0) return base

    const store = new GitSnapshotStore(runnerFor(git), {
      gitDir: join(stateDir(id), 'git'),
      workTree: cwd,
      untrackedFileMaxBytes,
      seed: { objectsDir: join(sourceGitDir, 'objects'), indexFile: sourceIndex },
    })
    try {
      await store.init()
    } catch (error) {
      ctx.logger.warn(`checkpoint: failed to initialize snapshot store for ${id}: ${String(error)}`)
      return base
    }
    return { ...base, isGitRepo: true, store }
  }

  async function ensureState(session: Session): Promise<SessionState> {
    const id = String(session.id)
    const existing = states.get(id)
    if (existing !== undefined) return existing
    const built = await buildState(session)
    states.set(id, built)
    return built
  }

  ctx.on('session/created', (session) => {
    void ensureState(session)
  })
  ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        void ensureState(session).then((state) => {
          if (!state.isGitRepo || state.store === null) return
          state.chain = state.chain
            .then(async () => {
              state.pendingPre = await state.store!.track()
            })
            .catch((error: unknown) => {
              ctx.logger.warn(`checkpoint: turn-start capture failed: ${String(error)}`)
            })
        })
      } else if (event.type === 'turn/end') {
        const turn = event.data.turn
        void ensureState(session).then((state) => {
          state.chain = state.chain
            .then(async () => {
              if (state.isGitRepo && state.store !== null) {
                const pre = state.pendingPre ?? state.lastTracked
                const post = await state.store.track()
                const changed = pre === post ? [] : await state.store.patch(pre, post)
                state.index = [...state.index.filter(record => record.turn !== turn), {
                  turn,
                  treeHash: post,
                  changed,
                  capturedAt: Date.now(),
                }]
                state.lastTracked = post
                state.pendingPre = null
              } else {
                state.index = [...state.index.filter(record => record.turn !== turn), {
                  turn,
                  treeHash: null,
                  changed: [],
                  capturedAt: Date.now(),
                }]
              }
              persistIndex(state)
            })
            .catch((error: unknown) => {
              ctx.logger.warn(`checkpoint: turn-end capture failed: ${String(error)}`)
            })
        })
      }
    })

  ctx.tools.register(defineTool({
    name: 'checkpoint_list',
    description: 'List the rollback points captured for this session. Each point corresponds to a completed turn; in a git workspace the file changes of that turn are recorded too.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          isGitRepo: { type: 'boolean', required: true },
          points: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn: { type: 'integer', required: true },
                changedCount: { type: 'integer', required: true },
                capturedAt: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Rollback points: ${value.points.map(point => `turn ${point.turn} (${point.changedCount} files)`).join(', ') || 'none'}. Git workspace: ${value.isGitRepo}.`,
      }],
    },
    execute: async (_args, exec) => {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('checkpoint_list requires an agent session')
      const state = await ensureState(session)
      return {
        isGitRepo: state.isGitRepo,
        points: state.index.map(record => ({
          turn: record.turn,
          changedCount: record.changed.length,
          capturedAt: record.capturedAt,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_restore',
    description: 'Roll the session back to a completed turn. In a git workspace the files changed after that turn are restored and the conversation is forked at that turn (the fork becomes the new session). In a non-git workspace only the conversation fork happens. The current state is snapshotted first, so the restore is undoable.',
    parameters: {
      turn: { type: 'number', required: true, description: 'The turn number to roll back to, from checkpoint_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          restored: { type: 'array', required: true, items: { type: 'string' } },
          childSessionId: { type: 'string' },
          contextOnly: { type: 'boolean', required: true },
          undoPoint: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.contextOnly
          ? `Rolled the conversation back to turn ${_args.turn} in session ${value.childSessionId ?? '(fork failed)'}; no files were restored (not a git workspace).`
          : `Restored ${value.restored.length} files and forked the conversation at turn ${_args.turn} into session ${value.childSessionId ?? '(fork failed)'}. Undo with checkpoint_restore(${value.undoPoint ?? '?'}).`,
      }],
    },
    execute: async (args, exec) => {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('checkpoint_restore requires an agent session')
      const state = await ensureState(session)
      const turn = args.turn
      const record = state.index.find(item => item.turn === turn)
      if (record === undefined) {
        const available = state.index.map(item => item.turn).join(', ') || 'none'
        throw new Error(`no checkpoint for turn ${turn} (available: ${available})`)
      }

      let restored: string[] = []
      let contextOnly = true
      let undoPoint: number | undefined
      if (state.isGitRepo && state.store !== null && record.treeHash !== null) {
        const preRevert = await state.store.track()
        restored = await state.store.restore(record.treeHash, preRevert)
        contextOnly = false
        const undo = latestTurn(session) + 1
        state.index = [...state.index.filter(item => item.turn !== undo), {
          turn: undo,
          treeHash: preRevert,
          changed: restored,
          capturedAt: Date.now(),
        }]
        state.lastTracked = record.treeHash
        persistIndex(state)
        undoPoint = undo
      }

      const boundary = findTurnEndSeq(session, turn)
      const child = boundary === undefined ? undefined : ctx.sessions.fork(session, boundary)
      return {
        restored,
        contextOnly,
        ...child === undefined ? {} : { childSessionId: String(child.id) },
        ...undoPoint === undefined ? {} : { undoPoint },
      }
    },
  }))
}
