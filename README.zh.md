# dsh-checkpoint

[English](README.md) | 中文

面向 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（`dsh`）的 git 快照 **checkpoint/回退**能力。

把会话回退到上一个**已完成的 turn**:git 工作树内同时还原文件与会话;非 git 工作树只回退会话,并由工具结果明示。

> **状态:spike 已定案,进入实现。** Task 0 spike 完成,结论为**方案 B**;下文的接口契约即 spike 之后的最终设计。本 README 是权威交接文档。

## 设计(已确定)

- **捕获粒度:每 turn**,而非每模型 step。一个 turn = 一次用户交互及其 agent 工作;回退落在已完成的 `turn/end` 边界上。每-step 捕获(opencode 式)是后续增强,明确排除在 MVP 外。
- **存储:每会话一个独立 git object DB**,位于 `<dataDir>/checkpoint/<sessionId>/git/`(`git init` 配 `GIT_DIR`/`GIT_WORK_TREE`),**只存 tree hash**——不在用户仓库里建任何 commit、branch 或 ref。当工作区本身是 git 仓库时,通过 `objects/info/alternates` + 复制 index 为其播种,复用已哈希的 blob(大仓库近乎零成本)。忽略 ignored 文件;超过体积上限(默认 2 MiB)的 untracked 文件跳过。
- **快照索引是插件自有文件**:`<dataDir>/checkpoint/<sessionId>/index.json`(每 turn 一条:turn 号、tree hash、变更路径、时间戳)。为什么索引不进会话日志,见 §Task 0。
- **git 检测 + 优雅降级**:每会话解析一次 git 工作树(`git rev-parse --is-inside-work-tree`)。是 git 仓库 → 文件+会话都回退;不是(或没有 `git` 可执行文件)→ 只回退会话;`checkpoint_list` 报告 `isGitRepo: false`,`checkpoint_restore` 拒绝文件还原。
- **回退 = fork + reseed**,保住 append-only 会话日志不变式:`ctx.sessions.fork(source, boundarySeq, childId)` 把日志切到目标 turn 的含端点 `turn/end` seq;git 层把文件还原到同一边界。没有 in-place 截断。
- **staged revert**:还原前先对当前状态再存一份快照,让撤销操作本身可撤销(opencode 语义)。

## Task 0 — spike 结论(方案 B)

问题:**本插件的 live 事件能否带上 `ignorable: true`?** 答案:**不能**。

- `Session.append`(`packages/core/session/src/index.ts`)的信封只由 `{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }` 构成;`SurfaceIntent` 没有其他字段。live 路径没有任何通道设置该标记。
- 持久化读取路径(`session-persistence/src/coordinator.ts` 的未知类型守卫)对 `KNOWN_SESSION_EVENT_TYPES` 之外的事件类型**硬拒绝**,除非持久化信封带 `ignorable: true`。
- harness 内没有任何 `ignorable: true` 的生产者;seed/restore 信封校验接受该键,但 live 生产不可达。

因此:**插件不向会话日志写任何自定义事件**。快照索引是插件自有文件;模型可见性由两个工具承担(`tool/call`/`tool/result` 都是已知事件类型,重载安全)。若未来 harness 为 live append 开放 ignorable 通道,插件可迁回「日志 `checkpoint/captured` 事件 + 投影」的方案 A——在此之前不要重新加事件。

## 接口契约

### 侧存索引(`<dataDir>/checkpoint/<sessionId>/index.json`)

```ts
interface CheckpointRecord {
  turn: number
  treeHash: string | null   // 工作区不是 git 仓库时为 null
  changed: string[]         // 本 turn 变更的路径
  capturedAt: number        // epoch 毫秒
}
```

### 工具

- `checkpoint_list` —— 参数 `{}`;结果:`{ isGitRepo: boolean, points: { turn, changedCount, capturedAt }[] }`。
- `checkpoint_restore` —— 参数 `{ turn: number }`;执行 fork+reseed + 文件还原 + 还原前自快照;结果:`{ restored: string[], childSessionId?: string, contextOnly: boolean }`。非 git 工作树时 `restored` 为空、`contextOnly: true`。

### Config

```ts
interface Config {
  dataDir?: string               // 默认:<dsh home>/checkpoint
  untrackedFileMaxBytes?: number // 默认 2 MiB
}
```

插件形态:函数插件,named export `name` / `inject` / `Config` / `apply`,无 default export(harness 惯例)。注入 `subprocess`、`sessions`、`tools`。

## 已标注的 harness 扩展点(已核实,无需重新调研)

- **`agent/pre-step` 与 `session/event` 流**是捕获触发器——插件只**读**不写。监听 `turn/start`(捕获 pre-tree)与 `turn/end`(捕获 post-tree + patch)。会话工作区是 `session.header.cwd`(持久数据)。
- **`ctx.sessions.fork(source, boundary?, childId?)`** —— 含端点边界 seq;所选前缀必须落在 open turn 之外(否则 `OPEN_TURN`);错误码 `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY | OPEN_TURN`。子会话继承 `cwd`、盖 `parentSession`、设 `seedLength`。
- **子进程** —— git 一律经 `ctx.subprocess.spawn({ argv, cwd, ... })` 执行;可执行文件用 `ctx.subprocess.resolveExecutable('git')` 解析,解析为空即优雅降级。任何地方都不得写 `process.platform` 分支。
- **测试组合所需的宿主服务**(真实 web profile 全部自带):`sessions`、`subprocess`(`subprocess-local`)、`tools`;完整会话冒烟还需要 subagent 全家、`shell`/`shellEnv`、`fs`、`web`、`userQuestions`、`jobs`、`skills`——与任何 preset 驱动的会话一致。

## 实现顺序

1. ✅ Spike(§Task 0)—— 结论 B 已记录。
2. `src/git-snapshot.ts` —— 独立 git object DB(init/track/restore/patch)、alternates 播种、untracked 体积上限。用真实 `git` 二进制在 tmpdir 中单测。
3. `src/index.ts` —— 函数插件:Config、每会话 git 工作树检测、捕获钩子、index.json 管理、两个工具、fork+reseed + staged restore。
4. 测试 —— 单测(git-snapshot)+ harness 检出内的真实组合冒烟(启动 spine、跑一个改文件的 turn、restore、断言文件还原)。
5. README(即本文件,保持最新)+ 打包清理。

## 验收标准

- git 工作树:跑一个改了文件的 turn,`checkpoint_restore` 到上一 turn —— 文件还原、会话在那一 turn 切断、且回退本身可撤销。
- 非 git 工作树:`checkpoint_list` 报告 `isGitRepo: false`;`checkpoint_restore` 只回退会话并报告 `contextOnly: true`;文件不动。
- 带 checkpoint 活动的会话在 first-party build 中重载干净(日志内无自定义事件)。
- 无 `bin` 入口;ESM-only;`@deepseek-ai/cordis` 与每个被 import 的 `@deepseek-ai/dsh-*` 都在 `peerDependencies` 中。

## 针对 harness 检出的开发方式

harness 包尚未进入稳定的公共 registry 节奏,因此基于本地检出开发:

1. 把 `deepseek-harness` clone 到本仓库旁,`pnpm install && pnpm run build`(构建生成启动所需的 `lib/typert.*` 产物)。
2. 在本仓库把要 import 的 harness 包以 `file:` 路径加进 `devDependencies`(如 `file:../deepseek-harness/packages/core/session`)。
3. 快速迭代:在 harness 检出内写临时 vitest spec,进程内启动 harness spine、`ctx.baseUrl` 指向 `apps/cli`、挂载本仓库的被测插件并驱动——随后删除 spec。长期归宿是本仓库内的真实组合 boot 测试。

## 边界与非目标

- 仅每 turn(无每-step 捕获)。
- 仅本地 git 工作树;非 git 工作区或远程后端(e2b/subprocess)不做 filesystem-copy 兜底(scheme C)。
- 会话回退始终可用;文件回退明确是 best-effort,范围仅限已快照的文件(ignored 文件、超限 untracked 文件与 shell 副作用永不还原)。

## 许可证

MIT