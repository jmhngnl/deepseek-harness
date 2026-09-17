---
description: "面向模型的 medical_case_update 工具，对会话已记录的病例应用一次增量变更并返回权威结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-case-update

[English](README.md) | 中文

## 概述

`medical_case_update` 变更本会话已记录的病例。它存在的原因是：一句补充——"还有恶心"、"25 岁，两天"——必须**追加**到已记录内容之上，而不是替换它。每个字段都可选，省略的字段保持原值，因此本工具绝不可能因为省略而抹掉已记录的事实。症状通过显式的 `symptomsAdd` 与 `symptomsRemove` 增量变更，只有在用户重述完整清单时才使用整体替换。没有造成任何变化的调用会被如实报告，不消耗修订号，也不追加事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在需要让模型扩展接诊记录而不是重述它处挂载本插件。它需要 `ctx.agents`、`ctx.medicalCase` 与 `ctx.tools`，并注册一个面向模型的工具。病例必须已存在；否则调用以明确错误失败，agent 应先用 `medical_case_intake` 记录它。

### 模型收到的契约

| 参数 | 含义 |
|---|---|
| `symptoms` | 整体替换清单。与两个增量参数互斥。 |
| `symptomsAdd` | 追加，保留已记录项。用于"还有……"。 |
| `symptomsRemove` | 删除已记录的症状，用于更正此前记录。 |
| `duration` | 替换文本；省略即保持。 |
| `age` | 替换的整年数；省略即保持。 |
| `additionalNotes` | 替换补充说明；省略即保持。 |

### 它会拒绝什么

| 调用 | 拒绝原因 |
|---|---|
| `symptoms` 与 `symptomsAdd` 或 `symptomsRemove` 同时出现 | 调用没有单一含义 |
| 同一症状同时出现在 add 与 remove | trim 之后的矛盾 |
| `symptoms: []` | 空列表只可能意味着抹掉已记录的症状 |
| `duration: ""` 或 `additionalNotes: "   "` | 空白只可能意味着抹掉已记录的事实 |

拒绝是普通工具错误：轮次继续，模型看到原因，病例保持不动。

### 症状绝不会被悄悄丢失

追加是模型面对补充信息的自然动作，而追加不可能丢数据——已记录的症状保持顺序，只有新的追加上去。替换仍然可用于真正的重述，但它绝不会是省略或增量所产生的结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察约定已在[使用本包](#use-this-package)中说明；本节解释单一定义如何产生这些行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件身份、参数与输出 schema，以及渲染 |
| — | 不发布运行时不变式伴生入口：本工具不拥有任何生命周期流，也不追加自己的会话事件，因此没有需要核对的独立观测。 |

### 消费方角色

插件注入 `['agents', 'medicalCase', 'tools']` 并只注册一个 `defineTool` 条目。它从执行信息中解析调用方 agent，把每一项 merge、修订与校验决策委托给 `ctx.medicalCase.applyPatch`，并渲染返回的权威视图。一次调用唯一的持久痕迹是 agent loop 记录的 `tool/call` + `tool/result` 事件对，以及变更被接受时领域追加的 `medical/case-change` 事件。

### 各拒绝发生在哪里

参数类型由 `defineTool` 在工具体运行之前检查。领域用稳定错误码拒绝有歧义或有损的 patch，注册表把它作为模型可见的错误结果上报；两条路径都不会中断轮次。

### 渲染

`output.render` 列出四个字段、`missingFields` 与 `revision`，并在无变化时明确说明。规范值保持结构化，也是 PTC 程序收到的值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [医疗接诊病例领域](../medical-case/README.zh.md)——本工具消费的 merge、修订与校验契约。
- [接诊工具](../tool-medical-case-intake/README.zh.md)——记录首次接诊病例的工具。
- [读取工具](../tool-medical-case-get/README.zh.md)——显式读取路径。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-update)——生成的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`medical_case_update` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-update)：六个可选参数，每个都自我描述，没有 `required` 列表。描述里写明了不清空规则、互斥规则，以及优先使用增量的建议。

#### Token 影响

工具可见时每个请求的固定 schema 开销。六个参数描述占了主要部分。

#### KV Cache 影响

只要定义与其可见性不变，前缀保持稳定。注册、卸载或限制该工具可能使从此 schema 起的复用失效。

### 工具调用历史与结果

#### 模型看到什么

模型自己的参数留在 assistant 工具调用块里。结果是渲染后的记录（含四个字段、`missingFields` 与 `revision`），或对于被拒绝的调用是确切的 `Error: <message>` 行。规范结构化值不展示，只有渲染文本。

#### Token 影响

每次调用一个结果，保留到 compaction。字段为空的记录约渲染七行。

#### KV Cache 影响

追加式；结果跟在可复用请求前缀之后，不会使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有清空操作**——按设计，没有任何参数会抹掉已记录事实或清空症状列表。带自身持久墓碑的刻意擦除动词属于延期工作。
- **没有比较并交换修订参数**——未向并发写入方提供期望修订号；领域仍会拒绝跳过或重复修订号的折叠记录。
- **单个症状除归一化外保持原样**——会 trim、去空白、去重，但不映射到受控词表。
- **`duration` 保持自由文本**——会 trim 但从不解析为区间。
- **记录不是跨会话的持久病例状态**——它属于一个会话，不会跟随用户进入新会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

互斥规则刻意做成一条检查，而不是更丰富的操作联合。用 `replace`/`add`/`remove` 操作字段会把同一个决策推到模型必须填对的第二处，而单规则版本更容易在描述里说明、测试成本也更低。

</details>
