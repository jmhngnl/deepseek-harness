---
description: "医疗接诊 Agent 的黄金用例评测框架：可版本化的用例契约、经真实 agent loop 的确定性回放，以及结构化报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-eval

[English](README.md) | 中文

## Summary

医疗接诊 Agent 的黄金用例评测：把「一次问诊必须做到什么」写成可版本化的数据，经真实 agent loop 针对脚本化模型或真实模型回放。判定依据是运行时派生出的权威病例状态，从不依据 assistant 的文案。纯函数 Evaluator 把每一轮变成已评估的断言，报告逐维度统计而不把一次运行压成一个分数。它只是测试基础设施：不注册任何工具、不发布任何服务，所以医疗 Agent 的模型可见面仍然只有三个工具。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包运行在测试或离线框架里，不运行在 Agent 的运行时里。无需挂载任何东西：它不发布插件、服务或工具。

### 流水线

```
GoldenCase
  → runGoldenCases
  → observeTurn
  → evaluateCase
  → buildReport
```

`runGoldenCases` 经真实 agent loop 回放，每个用例一个隔离的 harness；`observeTurn` 把一轮约简成纯数据；`evaluateCase` 做纯比较；`buildReport` 负责统计。

### 回放 shipped roster

```ts
import { loadGoldenCases, runGoldenCases } from '@deepseek-ai/dsh-medical-eval'

const runs = await runGoldenCases(loadGoldenCases(goldenDirectory), async golden => ({
  // One harness per case, disposed by the runner when the case ends.
  ctx: await bootTheCompositionUnderTest(golden),
  agent,
}))

const report = buildReport({ runId, startedAt, finishedAt, runtime, runs })
```

`setup` 是 runner 唯一不做决定的地方。它按用例交回一个 harness，runner 永远不会知道背后的模型是脚本还是真实路由 —— 这正是同一份 roster 与同一个 Evaluator 能同时服务两者的原因。

### 读一个失败

每个失败都带 `goldenCaseId`、`turnIndex`、`sessionId`、`failureType`、两侧的实际取值，以及可在持久日志里定位的会话序号。

```
expected-multi-turn turn 1: WRONG_TOOL — position 0 must call "medical_case_get",
  but the model called "medical_case_update"; expected ["medical_case_get"],
  actual ["medical_case_update"]
```

### 运行离线套件

```sh
pnpm vitest run packages/medical/medical-eval
```

其中每个测试都离线运行：不需要 API Key、不需要网络、不需要远端模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 契约本体：黄金用例、观测、失败分类法、报告 |
| [`src/runtime.ts`](src/runtime.ts) | 契约版本、读取器的错误类、JSON 收窄 |
| [`src/golden.ts`](src/golden.ts) | 黄金用例契约的严格读取器 |
| [`src/observe.ts`](src/observe.ts) | 会话事件 + 权威病例，合成一份稳定快照 |
| [`src/evaluate.ts`](src/evaluate.ts) | 纯 Evaluator：期望进，已评估断言出 |
| [`src/report.ts`](src/report.ts) | 聚合、报告契约，以及唯一的一处文件系统接缝 |
| [`src/runner.ts`](src/runner.ts) | 回放编排：隔离、轮次边界、时间上限 |
| `golden/*.json` | shipped roster，一个用例一份文档 |
| — | No runtime invariant companion is published：本包不注册服务也不注册工具，因此不存在可供运行时检查观测的跨插件关系；它自身的契约改由 spec 与逐文件覆盖率门禁钉住。 |

### 为什么用例是数据

黄金用例会被评审、被版本化、被针对真实模型回放，所以它不能是 spec 里的一个 `if`：读的人必须能在不读代码的情况下看见套件声明了什么，而一份声明必须可 diff。`schemaVersion` 随文档同行，读取器会拒绝它不认识的版本，因此扩展契约是一个可见的动作而不是无声的动作。

读取器还会**拒绝它未定义的成员**。没有这条规则，一个拼错的 `caseStete` 会被读成「没有状态期望」—— 这是唯一一种会在所有测试都通过的同时悄悄削弱套件的失效模式。

### 自包含的用例

每个用例都回放进一个全新会话，并自己陈述自己的历史。需要「已有记录」的用例，就在自己前面的轮次里把它记录出来；任何 runner 都不允许预置状态。roster 对此有检查：每个用例的第一轮都必须在修订号 1 上开出病例，而这只可能来自全新会话。

### 用例可以钉住什么

| 成员 | 含义 |
|---|---|
| `toolRouting.calls[].name` | 该位置模型必须调用的工具 |
| `toolRouting.calls[].arguments` | 该调用必须携带的取值 —— **可选**，子集匹配 |
| `caseState.symptoms` / `duration` / `age` / `additionalNotes` | 权威记录 |
| `caseState.revision` | 持久修订号 |
| `caseState.missingFields` | 派生的缺口报告 |
| `mutation.changed` / `eventCountDelta` / `operations` | 本轮对日志做了什么 |

两条策略让 roster 保持诚实而不是脆弱：

- **只在「抽取本身就是用例要点」时才钉住参数。** 当同一次正确调用的两种写法会产生同一份记录时，参数就不出现 —— 这样用例永远不会因为命名之外的原因失败。
- **自由文本只在其取值无歧义时才钉住** —— roster 钉 `duration: null`，并靠 `missingFields` 证明持续时间已被记录。模型往自由文本字段里写了什么，是关于它措辞的数据点，而不是契约。

### 失败分类法

Failure Taxonomy **v1**，位于 [`src/types.ts`](src/types.ts)。它是未来 bad-case 收集器的聚类键，因此新增成员属于契约变更：连同 schema 版本一起提升，而不是把一个名字复用于新的含义。它并非冻结 —— 它是版本化的。

`TOOL_NOT_CALLED` · `WRONG_TOOL` · `EXTRA_TOOL_CALL` · `TOOL_ERROR` ·
`ARGUMENT_EXTRACTION_ERROR` · `CASE_STATE_MISMATCH` · `MISSING_FIELDS_MISMATCH` ·
`REVISION_MISMATCH` · `UNEXPECTED_CASE_MUTATION` · `EXPECTED_MUTATION_MISSING` ·
`CASE_ID_CHANGED` · `SESSION_TIMEOUT` · `RUNTIME_ERROR`

两条规则让分类保持有意义：

- 参数错误**只**在期望钉住了某个取值时才报。没有钉住就没有关于「模型抽到了什么」的事实依据，因此病例状态的差异仍然是 `CASE_STATE_MISMATCH`，而不是猜测。
- `caseId`、`createdAt`、`updatedAt` 没有确定取值，所以断言的是它们的**连续性**：后面的修订号保持前面修订号的身份，且变更时钟不倒退。违反任一条都算病例状态不匹配，因为那正是读者该去看的状态。

### Evaluator 是纯函数

`evaluateTurn` 与 `evaluateCase` 不读会话、不碰文件、不调模型、不读时钟。Runner 负责观测，Evaluator 负责判定。这让报告可以从已存观测重新计算，也让未来的演化规划器无需起一套运行时即可复用。

### 报告不是分数

```ts
summary: {
  casesPassed, casesTotal,
  toolRoutingPassed, toolRoutingTotal,          // per turn
  stateAssertionsPassed, stateAssertionsTotal,  // per assertion
  missingFieldAssertionsPassed, missingFieldAssertionsTotal,
  toolErrors, unexpectedMutations, timeouts, runtimeErrors,
  passRate,
  usage: { inputTokens, outputTokens, observedTurns, totalTurns, complete },
  latencyMs: { totalMs, perCaseMs },
}
```

单一加权数字必须在有数据可依之前就先约定出来，而它的各个维度并不可互换。由此有两条规则：

- 路由**按轮次**计数，所以分母就是轮次数，与模型的行为无关。出错的那一轮没有产生可判定的路由断言，因此它计入分母的分母一侧而不是分子。
- usage 自带覆盖率。只对上报了 usage 的轮次求和，并同时带上计数，因此只测了一部分的运行读起来是「不完整的测量」而不是「便宜」。这里不做任何 token 估算：`length / 4` 不是 usage。

### 轮次边界

Runner 在放入本轮消息之前先读一次持久序号，只取高于该边界的事件，因此本轮的观测不会继承上一轮的调用或病例记录。时间上限通过**取消** agent 而不是放弃等待来施加：该轮随后收敛到 idle 并在日志里自我关闭，所以卡住的轮次仍会产生观测所读的 `turn/end`，harness 也仍能被释放。

### 为什么组合由调用方提供

Runner 不构建服务、不注册工具、不知道模型。在 harness 内部重新挂一套组合，等于多出一个必须与真正出货的那套保持同步的东西，所以调用方提供运行时，harness 只提供回放。这也是真实模型 runner 能存在而不需要第二条代码路径的原因。

### 集成接缝（Phase 3B）

两者都按决定未接线：本阶段只新增离线基础设施。

- **Bad-case 收集。** `ctx.messageFeedback.list({ sessionId })` 离线读取持久化的逐消息评分，因此负面反馈可以成为真实的生产用例来源。反馈以**非 surface** 事件存储，所以它永不进入模型历史 —— 这是工具自身 spec 钉住的性质。
- **用例发现。** `ctx.sessionQuery` 在 host 平面读取、过滤、追踪持久会话。把这项能力暴露给模型的 `session_search` 系列工具不进入医疗 Agent：收集器是离线消费者而非能力，而模型可见面保持三个工具。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [医疗病例子系统](../../../docs/subsystems/medical-case.zh.md) —— 每个用例据以判定的领域。
- [医疗分组地图](../README.zh.md) —— 本框架所服务的同组包。
- [MedHarness 运行时](../../../medharness/README.zh.md) —— 真实运行所回放的组合。
- [会话投影](../../session/session-projection/README.zh.md) —— 提供观测所读权威值的注册表。
- [Agent 循环](../../core/agent-loop/README.zh.md) —— runner 驱动的那个循环。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package registers no model-visible content：它是评测基础设施，从不挂载进 agent，因此不贡献任何工具、提示词文本或它自己的请求头。

#### KV Cache 影响

无；Evaluator 只遍历纯数据，runner 驱动的是一个既有的循环。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **还没有真实模型入口** —— 确定性 runner 已经完整，roster 也是按可对真实模型回放来写的，但「启动 MedHarness profile、对已配置模型跑一个子集、写出报告」的命令还没有做。那是下一步，而不是重新设计。
- **只有一种路由形态** —— 仅 `kind: 'exact'`。意图确实存在多条等价调用路径的轮次不会进 roster，也不会被写成备选列表，因为一个不止一个正确答案的期望无法为某个确定的原因失败。
- **每个会话只期望一个病例** —— 用例断言的是它自己的轮次建立起来的那个病例。多就诊历史需要领域先长出来。
- **自由文本按字面比较** —— `symptoms` 与 `duration` 在领域里是自由文本，所以钉住其一就是钉住模型的措辞。roster 正是出于这个原因不钉 `duration` 的文本；真实运行报出措辞差异，报的是关于模型的事实，而不是框架故障。
- **没有加权分，也没有准入闸门** —— 报告给出各维度与原始通过率。把它们变成合并闸门，属于有数据可依的那个阶段该做的决定。
- **观测不被持久化** —— 一次运行写的是报告，而不是据以计算它的快照，因此报告无法在未重放用例的情况下重新评估。持久化观测，才能让用例在 Evaluator 变化后被重新判定。
- **还没有聚类** —— 分类法已定义、且随每个失败同行，但还没有任何东西把跨运行的失败聚成 bad-case 家族。那是收集器的工作。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包刻意不被 `packages/bundle/medharness` 挂载。框架是被评测运行时的离线消费者，挂载它等于把评测基础设施放进被评测的东西里面。bundle 自身的测试会双向断言「声明的行」与「声明的依赖」完全相等，所以为这个包加一行会先让那条测试失败，根本到不了 agent 的可见面。

`src/index.ts` 是纯再导出模块，v8 会把它报成没有可度量语句。这就是它在限定范围的覆盖率运行里显示 0%、而逐文件门禁不会因此报错的原因。

`observeTurn` 是公开 API 且直接接收事件切片，所以它自己的 spec 覆盖了 runner 不会产生的日志形态 —— 不完整的边界对、空切片。那些是这条接缝的契约测试，而不是没有测试的防御代码。

</details>
