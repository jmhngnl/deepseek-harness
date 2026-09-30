---
description: "MedHarness 必须解决的五个工程问题，每个都按「问题 → 方案 → 实现 → 收益」写：领域建模、事件溯源、多模态附件接地、不可控生成风险，以及轨迹级评测。"
---

# MedHarness 工程设计

[English](medharness-engineering-design.md) | 中文

## 概述

本页记录一个跑在通用 Agent 运行时上的医疗接诊 Agent 真正会撞上的五个问题，以及代码对每一个做了什么。这里的每一条主张都有 `packages/medical` 下的包作依据，没有一条是设想。建议先读[架构页](medharness-architecture.zh.md)了解运行时接缝。

## 目录

- [1. 医疗领域建模](#1-medical-domain-modeling)
- [2. 事件溯源](#2-event-sourcing)
- [3. 多模态附件接地](#3-multimodal-attachment-grounding)
- [4. 降低不可控生成风险](#4-reducing-uncontrolled-generation-risk)
- [5. Agent 可靠性评测](#5-agent-reliability-evaluation)
- [开发备注](#dev-note)

-----

<a id="1-medical-domain-modeling"></a>
## 1. 医疗领域建模

### 问题

保存患者病例最顺手的去处就是对话本身。模型已经能看到它，用户已经打出来了，不需要任何额外机制。而它同时也是最差的去处。

一条 LLM 消息是散文。它没有 schema，所以无法校验。它在每次请求时从不断增长的对话记录里重新派生，所以一次压缩或截断就会静默丢事实。它是一条扁平序列，所以「患者多大」是一个搜索问题而不是一次查找。而且它常常是模型写的而非用户写的，于是记录与模型对记录的复述可以互相漂移，却没有仲裁者。

对医疗接诊而言，这种漂移正是全部风险所在：Agent 的职责就是**不**编造事实，而散文式的对话记录让它无法证明自己没有编造。

### 方案

两个持久领域，按「谁在说话」切分。

| 领域 | 记录 | 服务 | 事件 |
|---|---|---|---|
| `medical-case` | **患者**陈述的内容 | `ctx.medicalCase` | `medical/case-change` |
| `medical-image` | **模型**观察到的内容 | `ctx.medicalImage` | `medical/image-observation` |

这个切分是重点本身，不是实现细节。可见发现与患者陈述的症状是两类证据，可靠性不同、来源不同；把它们存在一起的系统，迟早会让其中一种变成另一种。这里两个领域拥有不同的事件、由不同投影折叠、由不同服务提供。图像路径里没有任何东西能写病例字段。

### 实现

病例是一个带单调修订号的值：

```ts
import type { CaseOperation, CaseState } from '@deepseek-ai/dsh-medical-case'

export interface MedicalCaseSnapshotChange {
  readonly kind: 'medical/case-change'
  readonly version: 1
  readonly operation: CaseOperation
  readonly case: CaseState
}
```

每个事件携带**变更后的完整状态**，从不携带增量。只读最近一条记录的投影就已经持有权威病例，因此「后写覆盖」重放与严格重放在构造上就一致。

读模型只增加一个派生字段：

```ts
import type { CaseState, MissingField } from '@deepseek-ai/dsh-medical-case'

export interface CaseView extends CaseState {
  readonly missingFields: MissingField[]
}
```

`missingFields` 在每次读取时由当前状态算出、从不持久化，所以记录与它的缺口报告不可能互相矛盾。这正是 Agent 能够去问缺失信息、而不是去猜的前提。

写入形状由工具契约而非调用方决定：`medical_case_update` 没有任何参数能清空字段，因此省略的值保持原值，后续回答永远无法抹掉已记录的内容。重复提交完全相同的快照是一次 no-op，不产生新修订号。

### 收益

病例变得可查询、可 diff、可证明。「患者从未提过持续时间」表现为一个字段的缺失，而不是一句模型没注意到的句子。每个事实都有修订号与事件序号，因此一条错误记录可以被追溯到写下它的那一轮。

<a id="2-event-sourcing"></a>
## 2. 事件溯源

### 问题

只存当前状态更简单 —— 直到有东西需要解释它。医疗接诊恰好就是这种情况：复核者可能需要知道某次更正之前记录长什么样；一次重启需要在不依赖原进程的前提下把状态找回来；第二个界面需要同一份事实，而不是第二个数据库。

### 方案

会话日志是唯一的持久存储。领域变更以事件形式追加；读模型是对这些事件的折叠。没有侧表写入，也没有隐藏的 JSON 文件。

### 实现

观察事件携带重放所需的一切，包括 canonical 附件引用与修订号：

```ts
import type { ImageObservationOperation, MedicalImageObservation } from '@deepseek-ai/dsh-medical-image'

export interface MedicalImageObservationChange {
  readonly kind: 'medical/image-observation'
  readonly version: 1
  readonly operation: ImageObservationOperation
  readonly observation: MedicalImageObservation
}
```

一条观察携带 `attachmentId`、`revision`、`bodyRegion`、`findings`、`quality`（一个 `usable` 判定加它的问题列表）与 `uncertainty`。因为每个变更事件都持有变更后的完整值，计算当前观察永远不需要把增量与更早的 payload 合并，持久流本身就能回答观察到了什么、在哪个修订号、针对哪张图。严格折叠仍然按序消费事件：单条快照无法承载的那些不变量 —— 产生它的操作、病例身份、修订号连续性、`createdAt` 顺序 —— 要对着它之前的事件校验。

每个领域注册一个投影：

```ts
import { applyMedicalImageProjection, medicalImageProjectionStateSchema } from '@deepseek-ai/dsh-medical-image'
import type { MedicalImageProjectionState } from '@deepseek-ai/dsh-medical-image'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export const medicalImageProjectionDefinition = {
  key: 'medicalImage',
  stateSchema: medicalImageProjectionStateSchema,
  init: (): MedicalImageProjectionState => ({ observations: [], failure: null }),
  apply: applyMedicalImageProjection,
  stateVersion: 1,
} satisfies ProjectionDefinition<'medicalImage', MedicalImageProjectionState>
```

注册表把已提交事件折叠成该状态，并周期性打检查点（交付 profile 里是 `writeEveryEvents: 200`、`writeIntervalMs: 5000`）。`stateVersion` 是逃生舱：折叠形状或其语义一旦改变就提升它，旧单元留下的持久检查点会被丢弃而不是向前套用。

### 这带来了什么

- **多轮修改。** 修订号 1 与修订号 2 是两个事件，所以编辑历史天然存在，无论有没有人要过。
- **历史。** 日志是追加式的，因此过去不会被现在覆盖。
- **冷启动恢复。** 新进程重放日志即可重建相同状态，不需要迁移，也没有快照格式要对齐。
- **状态回放。** 投影是事件的纯函数，所以状态随时可重算，并与实际服务出去的内容比对。

恢复能力不是理论。`packages/medical/medical-image/tests/persistence.spec.ts` 经生产写入器把一次观察写进真正的 JSONL 日志，dispose 上下文，再由第二个上下文打开同一份日志、重放投影、并在其上 resume 一个 agent —— 断言 attachment id、修订号、部位、发现、质量判定与不确定项全部存活。

<a id="3-multimodal-attachment-grounding"></a>
## 3. 多模态附件接地

### 问题

这是本项目最难的问题，而它只在模型能看图之后才出现。

图像以「字节 + 一个标识其附件的 handle」的形式到达模型。模型要记录观察时，必须把这个标识原样发回来。实践中它不会。一次针对真实视觉模型的 live 运行，在**同一轮**里给出了四种不同答案：

| 模型发来的值 | 它实际上是什么 |
|---|---|
| `synthetic-visible-patch.png` | 显示名 |
| `e9f65bf6…d1f2` | 被剥掉 `sha256:` 前缀的摘要 |
| `synthetic-visible-patch` | 去掉扩展名的 fixture id |
| `C:\Users\…\attachments\v1\objects\e9\e9f65bf6…` | 归一化副本的文件系统路径 |

四者全部被 `IMAGE_ATTACHMENT_NOT_IN_SESSION` 拒绝，该轮什么都没记下。拒绝是正确的 —— 但模型当时**没有可靠办法做对**，因为它读到的那段 handle 把显示名排在前面、把标识排在后面，还放在括号里没有字段名。

这不是提示词措辞的小毛病。这是一条**权限边界**：能引用自己从未收到过的附件的 Agent，就能伪造证据；能引用别的会话附件的 Agent，就能跨租户读取。

### 方案

三层，按重要性排列。

**1. 身份由存储铸造。** `AttachmentStore.admitPromptContent()` 是产生 `ImageAttachmentRef` 的唯一途径。id 是内容寻址的 —— 即字节的摘要 —— 所以同一张图被接收两次得到同一个 id，且没有任何调用方能宣称一个 harness 从未接收过的媒体类型、字节长度或尺寸。要说清这买到了什么：内容寻址给的是**身份**，不是**授权**。摘要让 id 稳定、并且对你没有的图很难编造，但它不是签名，也不说明**这个会话**是否有权使用那张图。某个被声称的 id 在这里是否可用，是下一层的问题，答案是**对着会话**回答的，不是对着字符串回答的。

**2. 领域对着会话授权。** `canonicalImageAttachment()` 在本会话自己派生出的消息里查找被声称的 id，并返回消息实际携带的那份引用 —— 从不是调用方给的那份。查找刻意做窄：本会话从未携带过的 id、属于另一个会话的 id、以及只存在于模型输出里的 id，得到**同一个**答案。区分它们等于告诉调用方别处存在哪些 id。

**3. 请求把身份写成字段。** 模型读到的 handle 被改写，让标识排在最前、带引号、保留前缀、并带字段名：

```text
Image: attachmentId="sha256:e9f65bf6…d1f2"; displayName="image-1.png" (display only); request preview 64x64px. …
```

显示名被显式标注为 display-only，工具描述则逐条列出这个标识**不是**什么：不是显示名、不是文件名、不是去掉前缀的摘要、不是文件路径、不是图片序号。

同一套推理还带出两个配套决定。评测框架里的 fixture 显示名改用位置式命名（`image-1.png`）而不是描述式，这样用例不可能靠「文件叫什么」来判定。授权层则为六种近失身份各写了测试 —— 显示名、去掉扩展名的名字、裸摘要、错前缀摘要、截断摘要、文件系统路径 —— 每一种都必须被拒绝，而 canonical id 仍须成功。

### 收益

模型无法发明一张图、无法够到别的会话的图、也无法让一个错误的 id 被静默规整成正确的。当它确实发来错误标识时，失败是一个有类型、可计数的错误，而不是一条被写坏的记录 —— 这才是它可被修好的原因。

<a id="4-reducing-uncontrolled-generation-risk"></a>
## 4. 降低不可控生成风险

### 问题

把一张皮肤照片交给 LLM，它会给出诊断。这是模型在做它被训练去做的事，而这恰恰是医疗接诊 Agent 不能交付的东西：一个语气笃定、背后却没有临床医生的临床结论，被当成证据记录下来。

这里的目标不是消除幻觉 —— 靠一个 schema 做不到，声称做得到是不诚实的。目标更窄、也可验证：**模型记录观察，而系统不给它任何能写下结论的字段。**

### 方案

下面每一条机制都是结构性的，没有一条依赖模型自觉。

| 机制 | 它移除了什么 |
|---|---|
| 工具 schema 形状 | 不存在 `diagnosis`、`disease`、`condition`、`treatment`、`medication`、`risk`、`urgency`、`triage`、`confidence` 参数，且有测试断言永不添加 |
| 只记观察的字段 | `findings` 被定义为直接可见的属性 —— 颜色、形状、大小、分布、表面外观 —— 并给出明确示例与明确禁止 |
| `usable` | 一个布尔值，让模型能说「这张图无法评估」，而不是去猜一张能评估的 |
| `qualityIssues` | 一个封闭枚举（`blur`、`poor_lighting`、`occlusion`、`too_distant`、`unable_to_assess`），让限制成为一个取值，而不是埋在散文里的免责声明 |
| `uncertainty` | 一个必填数组，记录无法判定的内容，让「我不知道」成为一种被记录的结果而不是省略 |
| `missingFields` | 病例读模型报告哪些必填事实缺失，让 Agent 去问而不是去推断 |
| 领域隔离 | 可见发现无法写进病例字段，因此模型的观察永远不会变成患者陈述的事实 |

这些禁止写在模型**调用之前立刻读到**的描述里，而不只是系统提示里：

```text
Record only what is DIRECTLY VISIBLE … Do NOT state a diagnosis, name a disease or
condition, suggest treatment or medication, or give a risk, urgency, or triage
judgement. Do NOT restate these findings as patient-reported symptoms.
```

交付 profile 里的人设则对纯文本路径重申同一条边界。

### 收益

失败模式的形状变了。不再是「Agent 告诉患者他大概得了湿疹」，最坏的可达结果变成「Agent 描述了一个红色圆形斑块，并标注该图像模糊」—— 这是关于一张图的真陈述，不是一项医疗主张。当模型确实在散文里越界时，它做出的工具调用仍然可审计，且其中仍不含任何临床字段，因此越界是可见的，而不是被编码进状态的。

诚实的边界：这约束的是系统**存储并据以行动**的东西。它不能阻止模型在聊天句子里写下诊断，本项目也不声称能。要检测那种情况需要语义判断 —— 这恰恰是评测框架拒绝假装关键词扫描能做到的原因。

<a id="5-agent-reliability-evaluation"></a>
## 5. Agent 可靠性评测

### 问题

聊天机器人可以靠读回复来测。Agent 不行。

Agent 的交付物不是它说的话，而是它做的事。「我已记录您的症状和年龄」是一句零成本就能生成、也什么都证明不了的句子。真正要命的失败是静默的：模型说它记下了，病例修订号却没动，而对话记录看起来一切正常。任何对话级测试都抓不到它，因为回复很流畅，而用户看不到事件日志。

### 方案

对照运行时派生出的权威状态评测**轨迹**，永不评测散文。

`packages/medical/medical-eval` 把版本化的黄金用例通过**真实** agent loop 回放，每个用例一套隔离 harness。只有模型是被脚本化的；会话、工具注册表、投影与领域服务都是生产实现。随后一轮被归约为纯数据，并做纯函数比对。

| 维度 | 断言内容 |
|---|---|
| Routing | 精确的工具调用序列，逐位置比对 |
| 病例状态 | 症状、持续时间、年龄、备注、修订号，以及派生的 `missingFields` |
| 图像状态 | 权威观察：attachment id、修订号、部位、发现、`usable`、质量问题、不确定项 |
| 变更 | 该轮是否追加了病例记录、图像记录，还是什么都没追加 |
| 工具错误 | 每一个报错的工具结果，均已分类 |

断言刻意分两档强度。脚本化用例钉精确值，因为它的模型就是一段脚本。live 用例钉结构 —— 该图像的观察存在、可用、修订号为 1、且至少记录一条发现 —— 因为真实模型的措辞不可复现，假装可以复现只会让测试套件说谎。

一次运行把各维度并排报出，而不是压成一个分数：

```text
cases=1/1 passed routing=1/1 state=3/3 missingFields=1/1
image=6/6 imageMutation=3/3 unexpectedImageMutations=0
toolErrors=0 unexpectedMutations=0 timeouts=0 runtimeErrors=0
```

同一套 harness 也能针对交付组合跑 live：经 app-boot loader 启动真实 profile，并断言「它测的就是它交付的」—— 载入的 profile 必须恰好组合交付的那几个 bundle，启动后的运行时必须恰好发布五个医疗工具。发现任何别的结果，这次运行会拒绝，而不是去报一堆关于「没人选择过的组合」的数字。

### 收益

可靠性变成一个能涨能跌的数字，以及一个能叫出名字的失败。一次回归会表现为第 2 轮的 `WRONG_TOOL`，或带持久日志序号可查的 `UNEXPECTED_CASE_MUTATION`，而不是「感觉这周变差了」这种模糊印象。因为 Evaluator 是纯函数 —— 不读时钟、不碰文件系统、不调模型 —— 报告可以从已存观察重算，这才让跨修订号的运行可比。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

图像领域的授权代码是本项目里唯一一处「失败模式是安全边界而不是正确性 bug」的地方，代码也是照着这个写的：id 出错的每一种方式共用一个错误码，每种近失形状各有一条测试，且不存在任何能把错误标识变成正确标识的规整路径。

评测框架刻意不做 assistant 散文分类。用关键词扫描疾病名既脆弱、又在两个方向上都可能错，还会把一条启发式包装成一次安全测量 —— 所以人设边界被强制在它该在的地方，而散文级安全评测留给未来一个能诚实做出语义判断的设计。

</details>
