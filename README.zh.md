# dsh-checkpoint

[English](README.md) | 中文

面向 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（`dsh`）的 git 快照 **checkpoint/回退**能力。

把会话回退到上一个**已完成的 turn**:git 工作树内同时还原文件与会话上下文;非 git 工作树只回退会话上下文,并由 UI 明示。

> **状态:实现前设计,spike 先行。** 本 README 是完整实现交接文档:决策已定、harness 扩展点已标注、第一项任务是一个有界 spike。新会话仅凭本文就能开工实现——编写本文时所对应的 deepseek-harness 检出目录中的总体设计文档(`dsh-main-loop-sisyphus-spec.md` §5)只是可选背景。

## 设计(已确定)

- **捕获粒度:每 turn**,而非每模型 step。一个 turn = 一次用户交互及其 agent 工作;回退落在已完成的 `turn/end` 边界上。每-step 捕获(opencode 式)是后续增强,明确排除在 MVP 外。
- **存储:每会话一个独立 git object DB**,位于 `<data-dir>/checkpoint/<sessionId>/`(`git init` 配 `GIT_DIR`/`GIT_WORK_TREE`),**只存 tree hash**——不在用户仓库里建任何 commit、branch 或 ref。当工作区本身是 git 仓库时,通过 `objects/info/alternates` + 复制 index 为其播种,复用已哈希的 blob(大仓库近乎零成本)。忽略 ignored 文件;超过体积上限(默认 2 MiB)的 untracked 文件跳过。
- **git 检测 + 优雅降级**:每会话解析一次 git 工作树(`git rev-parse --is-inside-work-tree`)。是 git 仓库 → 文件+会话都回退;不是(或没有 `git` 可执行文件)→ 只回退会话,并经投影 wire 值告知 UI。
- **回退 = fork + reseed**,保住 append-only 会话日志不变式:`ctx.sessions.fork(source, boundarySeq, childId)` 把日志切到目标 turn 的含端点 `turn/end` seq;git 层把文件还原到同一边界。没有 in-place 截断。
- **staged revert**:还原前先对当前状态再存一份快照,让撤销操作本身可撤销(opencode 语义)。

## 接口契约

### 会话事件

通过模块增强声明(模板是 plan-mode:`packages/plan/plan-mode/src/index.ts` 与 `src/types.ts`):

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** log-only,非 surface,whole-value。每个已完成 turn 一个 checkpoint。 */
    'checkpoint/captured': {
      turn: number
      treeHash: string | null   // 工作区不是 git 仓库时为 null
      changed: string[]         // 本 turn 变更的路径
      isGitRepo: boolean
    }
    /** log-only,非 surface。一次 restore 动作。 */
    'checkpoint/restored': {
      turn: number              // 回退目标 turn
      treeHash: string | null
      restored: string[]        // 实际还原的文件(仅上下文回退时为空)
    }
  }
}
```

另配 invariant companion(`src/invariant.ts`)校验两类 payload,注册方式仿 plan-mode。

### 投影

在 `ctx.sessionProjections` 上注册 `{ key: 'checkpoints', stateSchema, init, apply, wire, stateVersion }`。状态把 `checkpoint/captured` 折叠成按 turn 的索引 `{ turn, treeHash, changed }[]`。`wire.view` 暴露回退点列表与 `{ isGitRepo }`,自动流向 Web UI(session-controller 广播投影更新)——这就是「非 git repo」提示的通道。

### 工具

- `checkpoint_list` —— 参数 `{}`;结果列出回退点(turn 号、变更文件数、时间戳)与 `isGitRepo`。
- `checkpoint_restore` —— 参数 `{ turn: number }`;执行 fork+reseed + 文件还原 + 还原前自快照;结果说明还原了哪些文件、以及后续 turn 已不属于本会话。

### Config

```ts
interface Config {
  untrackedFileMaxBytes?: number   // 默认 2 MiB
}
```

插件形态:函数插件,named export `name` / `inject` / `Config` / `apply`,无 default export(harness 惯例)。注入下文的各项服务。

## 已标注的 harness 扩展点(已核实,无需重新调研)

- **`agent/pre-step`**(waterfall,`dsh-agent` 声明、`dsh-agent-loop` 派发):`(payload { agent, messages, turn, step, signal }, next) => Promise<PreStepDecision>`。规范捕获挂点——先 `await next()`,仅在 `decision.kind === 'enter' && !signal.aborted` 时执行捕获并 `agent.session.append(...)`。plan-mode(`packages/plan/plan-mode/src/index.ts`)正是该模式的参考实现。
- **`Session.append`**(`packages/core/session/src/index.ts`)**不暴露 `ignorable` 参数**——这恰是 spike 的全部主题。`KNOWN_SESSION_EVENT_TYPES`(`packages/core/session/src/known-event-types.ts`)是仓库静态生成的;外部事件不在其中即为 required-on-read,first-party 持久化加载会拒绝携带它们且信封没有 `ignorable: true` 的会话。背景:harness 检出目录中的 Agent Note `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。
- **`ctx.sessions.fork(source, boundary?, childId?)`** —— 含端点边界 seq;所选前缀必须落在 open turn 之外(否则 `OPEN_TURN`);错误码 `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY | OPEN_TURN`。子会话继承 `cwd`、盖 `parentSession`、设 `seedLength`。
- **子进程** —— git 一律经 `ctx.subprocess.spawn({ argv, cwd, ... })` 执行;可执行文件用 `ctx.subprocess.resolveExecutable('git')` 解析,解析为空即优雅降级。任何地方都不得写 `process.platform` 分支。
- **插件行所需的宿主服务**(测试组合用——真实 web profile 全部自带):`shell`+`shellEnv`(来自 `bash-local`/`shell-env`)、`fs`(`fs-local`)、`subprocess`(`subprocess-local`)、`web`(`dsh-web` + 一个 provider)、`userQuestions`(`dsh-user-questions`)、`jobs`(`jobs-local`)、`skills`、`subagents`(+ `spawn`/`fork` provider)。函数插件以 namespace 模块注册,服务类以 default export 注册。

## 任务 0 —— ignorable spike(先做这个)

问题:**本插件的 live 事件能否带上 `ignorable: true`?**

1. 在 deepseek-harness 检出目录中阅读 `Session.append` 与持久化层(`packages/session/session-persistence`,`PersistenceCoordinator` 的拒绝路径)。确认是否存在任何 append/restore 路径能为 live 事件接受 `ignorable` 标记。
2. 二选一:
   - **A(优先)**:存在该路径 —— 将 checkpoint 事件声明为 informational、打上 ignorable,保留在会话日志中。
   - **B**:不存在 —— 把快照索引移到插件私有 side-store(`ctx.storage`),仅将 restore 动作留作 surface 事件,并同步更新本 README 的接口契约一节。
3. 把结论写回本 README(替换本小节),然后继续。

这是架构决定而非外观问题:方案 B 改变 checkpoint 状态的存放位置,因此它把关全部后续代码。

## 实现顺序

1. Spike(§任务 0),记录结论。
2. `src/git-snapshot.ts` —— 独立 git object DB(init/track/restore/patch),含 alternates 播种与 untracked 体积上限。
3. `src/index.ts` —— 真正的函数插件:Config、服务注入清单、git 工作树检测、`agent/pre-step` 捕获挂点、事件 append。
4. `src/types.ts` + `src/invariant.ts` —— 事件声明与 payload 校验。
5. 投影注册 + wire view。
6. `checkpoint_list` / `checkpoint_restore` 工具 + fork+reseed + staged restore。
7. 非 git 降级路径(仅上下文回退 + 投影提示)。
8. 测试 —— 一个 REAL-composition 测试(harness 政策:产品插件必须;经 Loader 启动测试用 cordis.yml)加上快照模块的聚焦单测(tmpdir 内,无网络)。
9. README(即本文件,保持最新)+ 打包清理。

## 验收标准

- git 工作树:跑一个改了文件的 turn,`checkpoint_restore` 到上一 turn —— 文件还原、会话在那一 turn 切断、且回退本身可撤销。
- 非 git 工作树:`checkpoint_list` 报告仅上下文回退;文件不动;UI 提示出现。
- 事件 payload 过 invariant;投影 wire 值经 session-controller 到达客户端。
- `checkpoint/captured` 永不破坏 first-party 会话重载(spike 结论落成明文)。
- 无 `bin` 入口;ESM-only;`@deepseek-ai/cordis` 与每个被 import 的 `@deepseek-ai/dsh-*` 都在 `peerDependencies` 中。

## 针对 harness 检出的开发方式

harness 包尚未进入稳定的公共 registry 节奏,因此基于本地检出开发:

1. Clone `deepseek-harness`,`pnpm install && pnpm run build`(构建会生成启动所需的 `lib/typert.*` 产物)。
2. 在本仓库把要 import 的 harness 包加进 `devDependencies`,用 `file:`/`link:` 路径(或 pnpm workspace overlay)。
3. 验证方式与 sisyphus preset 的设计验证一致:在 **harness 检出目录内**写一个临时 vitest spec,进程内启动 harness spine、`ctx.baseUrl` 指向 `apps/cli`、挂载本仓库的被测插件并驱动它——随后删除该 spec。(长期归宿是本仓库内的 boot 测试;harness 内的 scratch spec 是快速迭代环。)真实模型冒烟:从 harness 根 `.env` 读取 key,路由 `deepseek-official` / `deepseek-v4-flash`。

## 边界与非目标

- 仅每 turn(无每-step 捕获)。
- 仅本地 git 工作树;非 git 工作区或远程后端(e2b/subprocess)不做 filesystem-copy 兜底(scheme C)。
- 会话回退始终可用;文件回退明确是 best-effort,范围仅限已快照的文件(ignored 文件、超限 untracked 文件与 shell 副作用永不还原)。

## 许可证

MIT