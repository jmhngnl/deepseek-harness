---
description: "医疗接诊 Agent 的黄金用例评测框架：可版本化的用例契约、经真实 agent loop 的确定性回放，以及结构化报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-eval

[English](README.md) | 中文

## Summary

医疗接诊 Agent 的黄金用例评测：把「一次问诊必须做到什么」写成可版本化的数据，经真实 agent loop 针对脚本化模型或真实模型回放。判定依据是运行时派生出的权威状态——报告的病例与模型的图像观察——从不依据 assistant 的文案。纯函数 Evaluator 把每一轮变成已评估的断言，报告逐维度统计而不把一次运行压成一个分数。它只是测试基础设施：不注册任何工具、不发布任何服务。

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

```ts ignore-check
import { loadGoldenCases, runGoldenCases } from '@deepseek-ai/dsh-medical-eval'

const runs = await runGoldenCases(loadGoldenCases(goldenDirectory), async golden => ({
  // One harness per case, disposed by the runner when the case ends.
  ctx: await bootTheCompositionUnderTest(golden),
  agent,
}))

const report = buildReport({ runId, startedAt, finishedAt, runtime, runs })
```

`setup` 是 runner 唯一不做决定的地方。它按用例交回一个 harness，runner 永远不会知道背后的模型是脚本还是真实路由 —— 这正是同一份 roster 与同一个 Evaluator 能同时服务两者的原因。

### 运行 live smoke

```sh
pnpm medharness:eval                                    # the three-case text smoke
pnpm medharness:eval --case get-reads-without-changing   # one named case
pnpm medharness:eval --case image-live-smoke-visible-patch  # the one image smoke
pnpm medharness:eval --all                               # the whole roster, images included
```

默认 smoke 刻意保持纯文本：它便宜且稳定，而把一次视觉调用塞进每一次普通运行，只会让本不涉及它的回归去消耗图像 token。image smoke 是一个具名用例，所以它只花一次请求，而且是显式要求的。

带图像的用例在发出第一个请求之前会被检查一次：组合解析出的 route 必须接受图像输入。对于声明了自己的模态、却不含 `image` 的 route，harness 会把每一张图投影成占位文本，所以没有这道检查，纯文本 route 不会失败——这次运行会悄悄测出一个文本 smoke，却把自己报告成视觉 smoke。声明了「没有模态」的 route 会继续执行，因为「没有声明」意味着「未知」而不是「仅文本」，而且请求里仍然带着图像。

`runLiveEval` 通过 app-boot loader 启动 **shipped 的 `medharness` profile**——真实的 profile 目录、真实的 bundle 层、`dsh` launcher 使用的那个被修复过的 module fallback——自己不挂载任何插件，所以基准测的是真正交付的组合，而不是它的二次拼装。有两处刻意的减法，并且在源码里写明：排除 `@deepseek-ai/dsh-headless` 这组一次性 CLI 行（它们会去驱动自己的任务），并跳过 profile 的用户层（否则一处本机 patch 就能重新定义「shipped profile」的含义）。仅跳过 patch 层还不够：`app-boot` 只会在 profile manifest 的 `dsh.profile.bundles` 仍等于 shipped 模板时才做归一化，其它任何列表都按「用户自有」原样保留，于是一份手改过的 `package.json` 照样会被启动、并且照样被报告成 shipped。因此这次运行会断言「载入的 profile 恰好组合了 shipped 的那几个 bundle」，不符合就拒绝测量——是拒绝，不是修复：被拒的 profile 会被原样留在那里。报告记录的是**启动后的组合自己解析出来的 route**，一次运行里的每个用例都必须解析出同一条 route，否则根本不会写出报告；并且一旦组合发布了五个医疗工具之外的任何东西，这次运行会直接拒绝。

Live 失败也是结果。这里不修用例、不放宽期望、不重跑到碰巧通过；失败分类、expected/actual、以及日志里的 seq 都会和其它运行一样落进报告。报告写入 `.medharness/eval-runs/`，与 session 日志放在一起，而不是进版本历史。

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
| `mutation.changed` / `eventCountDelta` / `operations` | 本轮对病例日志做了什么 |
| `imageObservations[].imageKey` | 该期望针对哪张附加图像 —— **必填** |
| `imageObservations[].bodyRegion` / `findings` / `usable` / `qualityIssues` / `uncertainty` | 权威观察 |
| `imageObservations[].minimumFindings` | 发现数量的下界，用于不该锁定措辞的期望 |
| `imageObservations[].revision` | 该观察的持久修订号 |
| `imageMutation.changed` / `eventCountDelta` / `events` | 本轮对图像日志做了什么 |

三条策略让 roster 保持诚实而不是脆弱：

- **只在「抽取本身就是用例要点」时才钉住参数。** 当同一次正确调用的两种写法会产生同一份记录时，参数就不出现 —— 这样用例永远不会因为命名之外的原因失败。
- **自由文本只在其取值无歧义时才钉住** —— roster 从不钉 `duration` 的字面值。用户一旦提供了持续时间，其措辞就有多种等价写法，所以这类用例钉的是 `missingFields: []`：它才是「持续时间已被记录」的证据。字面量 `duration: null` 只出现在用户未提供持续时间的用例里，在那里它是「没有凭空编造」的证据。模型往自由文本字段里写了什么，是关于它措辞的数据点，而不是契约。
- **`findings` 与 `minimumFindings` 互斥。** 脚本化用例可以钉住精确列表，因为它的模型就是一段脚本；live 用例只钉住「观察者确实发现了东西」，因为真实观察者的措辞不可复现。同一个期望里同时出现两者是契约错误，而不是一条优先级规则。

### 附加的图像

一个 turn 通过注册表 id 附加合成图像：

```json
{
  "user": "请看一下我拍的照片",
  "images": [{ "key": "image-1", "fixture": "synthetic-visible-patch" }],
  "expect": {
    "toolRouting": { "kind": "exact", "calls": [{ "name": "medical_image_observe" }] },
    "imageObservations": [{ "imageKey": "image-1", "revision": 1, "usable": true, "minimumFindings": 1 }],
    "imageMutation": {
      "changed": true,
      "eventCountDelta": 1,
      "events": [{ "imageKey": "image-1", "operation": "observe", "revision": 1 }]
    }
  }
}
```

用例里从不存放字节、路径或 attachment id。`fixture` 通过 [`src/fixtures.ts`](src/fixtures.ts) 里的封闭注册表解析，loader 会拒绝注册表没有的 id——所以基准数据不会变成文件系统读取契约，fixture 目录也可以整体搬走而不必改写任何用例。每一个 fixture 都是本仓库生成的合成栅格；见 [`fixtures/images/README.zh.md`](fixtures/images/README.zh.md)。

随后 runner 走的是真实路径：

```
fixture bytes → ctx.attachments.admitPromptContent → canonical ImageAttachmentRef
  → ImageBlock → createUserMessage → agent.followup
```

它从不自行铸造 id、从不算哈希、也从不猜尺寸：admission 是产生引用的唯一途径，所以图像用例测的是集成，而不是对集成的描述。`key` 只是评测元数据——领域完全不知道它存在。用例和期望靠它指认一张图，而不必钉住 admission 铸造出的摘要；观察者也是靠它把 attachment id 解析回语义身份。

live 用例的期望钉的是结构而不是措辞：该图像的观察存在、可用、revision 为 1、且至少记录了一条发现。这不是降低标准——它是把断言中结构的那一半，与依赖某个模型恰好如何措辞的那一半分开。

<a id="the-failure-taxonomy"></a>
### 失败分类法

Failure Taxonomy **v2**，位于 [`src/types.ts`](src/types.ts)。它是未来 bad-case 收集器的聚类键，因此新增成员属于契约变更：连同 schema 版本一起提升，而不是把一个名字复用于新的含义。它并非冻结 —— 它是版本化的。

`TOOL_NOT_CALLED` · `WRONG_TOOL` · `EXTRA_TOOL_CALL` · `TOOL_ERROR` · `ARGUMENT_EXTRACTION_ERROR` · `CASE_STATE_MISMATCH` · `MISSING_FIELDS_MISMATCH` · `REVISION_MISMATCH` · `UNEXPECTED_CASE_MUTATION` · `EXPECTED_MUTATION_MISSING` · `CASE_ID_CHANGED` · `IMAGE_OBSERVATION_MISMATCH` · `IMAGE_REVISION_MISMATCH` · `UNEXPECTED_IMAGE_MUTATION` · `EXPECTED_IMAGE_MUTATION_MISSING` · `SESSION_TIMEOUT` · `RUNTIME_ERROR`

图像成员刻意只有四个。图像工具没被调用或调错，已经由 `TOOL_NOT_CALLED` / `WRONG_TOOL` 覆盖；钉住的参数不对，已经由 `ARGUMENT_EXTRACTION_ERROR` 覆盖；只有图像领域自己的对象——权威观察、它的修订号、以及持久记录——需要自己的名字。

三条规则让分类保持有意义：

- 参数错误**只**在期望钉住了某个取值时才报。没有钉住就没有关于「模型抽到了什么」的事实依据，因此病例状态的差异仍然是 `CASE_STATE_MISMATCH`，而不是猜测。
- `caseId`、`createdAt`、`updatedAt` 没有确定取值，所以断言的是它们的**连续性**：后面的修订号保持前面修订号的身份，且变更时钟不倒退。违反任一条都算病例状态不匹配，因为那正是读者该去看的状态。
- 期望指向的某张图，会话里没有任何观察时，只在**那张图**上失败**一次**，而不是为每个被钉住的字段各报一条。一个根因产生一条失败。

### 分类法刻意不做什么

这里没有、也不会有针对 assistant 文案的分类。判断一句回复是否给出了诊断需要语义判断，而本包能拥有的确定性分类器做不到这件事：用关键词扫描疾病名称既脆弱、又在两个方向上都可能错，还会把一条启发式包装成一次安全测量。「不诊断」这条边界被强制在它该在的地方——提示词里，以及没有字段可以容纳临床结论的工具契约里——而一次需要语义判断的安全评测，应当被设计成一次安全评测：用一个结构化的策略 Evaluator，或一个外部裁判，而不是把它塞进一个确定性基准。

### Evaluator 是纯函数

`evaluateTurn` 与 `evaluateCase` 不读会话、不碰文件、不调模型、不读时钟。Runner 负责观测，Evaluator 负责判定。这让报告可以从已存观测重新计算，也让未来的演化规划器无需起一套运行时即可复用。

### 报告不是分数

```text
summary: {
  casesPassed, casesTotal,
  toolRoutingPassed, toolRoutingTotal,          // per turn
  stateAssertionsPassed, stateAssertionsTotal,  // per assertion
  missingFieldAssertionsPassed, missingFieldAssertionsTotal,
  imageAssertionsPassed, imageAssertionsTotal,  // per assertion
  imageMutationAssertionsPassed, imageMutationAssertionsTotal,
  unexpectedImageMutations,
  toolErrors, unexpectedMutations, timeouts, runtimeErrors,
  passRate,
  usage: { inputTokens, outputTokens, observedTurns, totalTurns, complete },
  latencyMs: { totalMs, perCaseMs },
}
```

单一加权数字必须在有数据可依之前就先约定出来，而它的各个维度并不可互换。由此有三条规则：

- 路由**按轮次**计数，所以分母就是轮次数，与模型的行为无关。出错的那一轮没有产生可判定的路由断言，因此它计入分母的分母一侧而不是分子。
- usage 自带覆盖率。只对上报了 usage 的轮次求和，并同时带上计数，因此只测了一部分的运行读起来是「不完整的测量」而不是「便宜」。这里不做任何 token 估算：`length / 4` 不是 usage。
- 患者陈述的状态与模型观察到的证据保持为**彼此独立的维度**，理由与它们是彼此独立的领域相同。病例完美、图像观察全错的运行，不能被平均成一个数字，把哪一半坏了藏起来。

报告逐轮携带权威图像观察的投影：`imageKey`、`revision`、`bodyRegion`、`findings`、`usable`、`qualityIssues`、`uncertainty` 以及 attachment id。它绝不携带图像字节、base64、fixture 路径或附件存储位置——有测试断言这一点。

### 轮次边界

Runner 在放入本轮消息之前先读一次持久序号，只取高于该边界的事件，因此本轮的观测不会继承上一轮的调用或病例记录。时间上限通过**取消** agent 而不是放弃等待来施加：该轮随后收敛到 idle 并在日志里自我关闭，所以卡住的轮次仍会产生观测所读的 `turn/end`，harness 也仍能被释放。

### 为什么组合由调用方提供

Runner 不构建服务、不注册工具、不知道模型。在 harness 内部重新挂一套组合，等于多出一个必须与真正出货的那套保持同步的东西，所以调用方提供运行时，harness 只提供回放。这也是真实模型 runner 能存在而不需要第二条代码路径的原因。

### 集成接缝（Phase 3B）

两者都按决定未接线：本阶段只新增离线基础设施。

- **Bad-case 收集。** `ctx.messageFeedback.list({ sessionId })` 离线读取持久化的逐消息评分，因此负面反馈可以成为真实的生产用例来源。反馈以**非 surface** 事件存储，所以它永不进入模型历史 —— 这是工具自身 spec 钉住的性质。
- **用例发现。** `ctx.sessionQuery` 在 host 平面读取、过滤、追踪持久会话。把这项能力暴露给模型的 `session_search` 系列工具不进入医疗 Agent：收集器是离线消费者而非能力，而模型可见面保持五个工具。

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

- **CI 不覆盖 live 路径** —— 这里的每个测试都提供脚本化的 route，因为测试套件不该花掉一次真实模型请求。因此「不传 route、走组合自己配置的模型」这条路径只有在有人手动跑 `pnpm medharness:eval` 时才会被执行，而套件不会察觉它坏掉。两条路径的差别只在 selection 从哪来：其后的启动、surface 守卫、回放、报告，都是同一份代码。
- **只有一种路由形态** —— 仅 `kind: 'exact'`。意图确实存在多条等价调用路径的轮次不会进 roster，也不会被写成备选列表，因为一个不止一个正确答案的期望无法为某个确定的原因失败。
- **每个会话只期望一个病例** —— 用例断言的是它自己的轮次建立起来的那个病例。多就诊历史需要领域先长出来。
- **自由文本按字面比较** —— `symptoms` 与 `duration` 在领域里是自由文本，所以钉住其一就是钉住模型的措辞。roster 正是出于这个原因不钉 `duration` 的文本；真实运行报出措辞差异，报的是关于模型的事实，而不是框架故障。
- **没有加权分，也没有准入闸门** —— 报告给出各维度与原始通过率。把它们变成合并闸门，属于有数据可依的那个阶段该做的决定。
- **观测不被持久化** —— 一次运行写的是报告，而不是据以计算它的快照，因此报告无法在未重放用例的情况下重新评估。持久化观测，才能让用例在 Evaluator 变化后被重新判定。
- **还没有聚类** —— 分类法已定义、且随每个失败同行，但还没有任何东西把跨运行的失败聚成 bad-case 家族。那是收集器的工作。
- **图像 fixture 是三张合成栅格** —— 一个圆盘、一个方块、一片无法分辨的色场。它们测的是观察流水线的结构，而不是模型的临床视觉：用例可以断言观察者描述了一个形状，这里没有任何东西声称它能描述一片皮疹。
- **不做 assistant 文案的安全分类** —— 判断一句回复是否给出了诊断，需要本包无法确定性做出的语义判断。见[分类法刻意不做什么](#the-failure-taxonomy)。
- **live image smoke 断言的是结构，不是措辞** —— 它钉住观察存在、可用、revision 为 1、且至少记录了一条发现。真实运行报出措辞差异，报的是关于模型的事实，而这个用例的写法让它不会因此失败。
- **live smoke 只在被要求时才花图像 token** —— 默认调用保持纯文本，所以普通的回归运行不会为一次视觉请求付费。`--all` 会包含图像用例，因为全量基准是被显式要求的。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包刻意不被 `packages/bundle/medharness` 挂载。框架是被评测运行时的离线消费者，挂载它等于把评测基础设施放进被评测的东西里面。bundle 自身的测试会双向断言「声明的行」与「声明的依赖」完全相等，所以为这个包加一行会先让那条测试失败，根本到不了 agent 的可见面。

`src/index.ts` 是纯再导出模块，v8 会把它报成没有可度量语句。这就是它在限定范围的覆盖率运行里显示 0%、而逐文件门禁不会因此报错的原因。

`observeTurn` 是公开 API 且直接接收事件切片，所以它自己的 spec 覆盖了 runner 不会产生的日志形态 —— 不完整的边界对、空切片。那些是这条接缝的契约测试，而不是没有测试的防御代码。

</details>
