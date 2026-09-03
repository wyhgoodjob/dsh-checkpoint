/**
 * Real-composition smoke for dsh-checkpoint, run inside a deepseek-harness
 * checkout (it imports harness packages and a scratch copy of the plugin):
 *
 *   1. Copy src/index.ts and src/git-snapshot.ts into the harness checkout
 *      at .scratch-checkpoint/ (the import below resolves that path).
 *   2. Copy this file to packages/preset/agent-presets/tests/ in the harness.
 *   3. pnpm exec vitest run packages/preset/agent-presets/tests/harness-checkpoint.spec.ts
 *
 * Covers: git-worktree capture + checkpoint_restore (file revert + fork at the
 * turn boundary) and non-git context-only degradation.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as Checkpoint from '../../../../.scratch-checkpoint/index.ts'
import { describe, expect, it } from 'vitest'

const APP_BASE = pathToFileURL('/home/clover/deepseek-harness/apps/cli').href + '/'

async function harness(dataDir: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = APP_BASE
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(Checkpoint, { dataDir })
  return ctx
}

async function poll(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('poll timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function execute(ctx: Context, name: string, args: unknown, agent: never): Promise<unknown> {
  return ctx.tools.execute({
    callId: 'scratch-call' as never,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  } as never)
}

describe('scratch: dsh-checkpoint plugin', () => {
  it('captures turns and restores files via fork+reseed in a git worktree', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-checkpoint-smoke-'))
    const work = join(base, 'work')
    mkdirSync(work, { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: work })
    const dataDir = join(base, 'data')

    const ctx = await harness(dataDir)
    const handle = await ctx.agents.create({
      sessionId: SessionId('s-cp'),
      meta: { cwd: work },
      setup: async () => {},
    })
    const session = handle.agent.session

    session.append('turn/start', { turn: 1 })
    writeFileSync(join(work, 'a.txt'), 'v1')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const indexFile = join(dataDir, 'checkpoint', 's-cp', 'index.json')
    await poll(() => existsSync(indexFile) && readFileSync(indexFile, 'utf8').includes('"turn":1'))
    const firstIndex = JSON.parse(readFileSync(indexFile, 'utf8')) as { turn: number; changed: string[] }[]
    expect(firstIndex.find(record => record.turn === 1)?.changed).toEqual(['a.txt'])

    session.append('turn/start', { turn: 2 })
    writeFileSync(join(work, 'a.txt'), 'v2')
    writeFileSync(join(work, 'b.txt'), 'extra')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await poll(() => readFileSync(indexFile, 'utf8').includes('"turn":2'))

    const restoreResult = await execute(ctx, 'checkpoint_restore', { turn: 1 }, handle.agent as never)
    console.log('RESTORE RESULT:', JSON.stringify(restoreResult).slice(0, 400))

    await poll(() => readFileSync(join(work, 'a.txt'), 'utf8') === 'v1')
    expect(existsSync(join(work, 'b.txt'))).toBe(false)

    const listResult = await execute(ctx, 'checkpoint_list', {}, handle.agent as never)
    console.log('LIST RESULT:', JSON.stringify(listResult).slice(0, 300))
    expect(JSON.stringify(listResult)).toContain('"isGitRepo":true')

    await handle.dispose()
    ctx.once === undefined
  }, 60_000)

  it('degrades to context-only rollback outside a git worktree', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-checkpoint-nongit-'))
    const work = join(base, 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'plain.txt'), 'keep')
    const dataDir = join(base, 'data')

    const ctx = await harness(dataDir)
    const handle = await ctx.agents.create({
      sessionId: SessionId('s-ng'),
      meta: { cwd: work },
      setup: async () => {},
    })
    const session = handle.agent.session

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const indexFile = join(dataDir, 'checkpoint', 's-ng', 'index.json')
    await poll(() => existsSync(indexFile) && readFileSync(indexFile, 'utf8').includes('"turn":1'))

    const listResult = await execute(ctx, 'checkpoint_list', {}, handle.agent as never)
    console.log('NONGIT LIST RESULT:', JSON.stringify(listResult).slice(0, 300))
    expect(JSON.stringify(listResult)).toContain('"isGitRepo":false')

    const restoreResult = await execute(ctx, 'checkpoint_restore', { turn: 1 }, handle.agent as never)
    console.log('NONGIT RESTORE RESULT:', JSON.stringify(restoreResult).slice(0, 300))
    expect(JSON.stringify(restoreResult)).toContain('"contextOnly":true')
    expect(readFileSync(join(work, 'plain.txt'), 'utf8')).toBe('keep')

    await handle.dispose()
  }, 60_000)
})
