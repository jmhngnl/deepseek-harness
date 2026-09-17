---
description: "面向模型的 medical_case_get 工具，只读地返回本会话的权威病例记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-case-get

[English](README.md) | 中文

## 概述

`medical_case_get` 读取本会话已记录的病例，以及仍然缺失的必填事实。它是显式的读取路径：记录来自会话的持久病例状态而不是对话内容，因此重启、恢复、fork 或一段无关对话之后，读到的仍是同一份记录。本工具不改变任何东西——不追加事件、不消耗修订号——并在会话尚未记录病例时明确失败。

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

在需要让模型重新核对"实际到底记录了什么"处挂载本插件。它需要 `ctx.agents`、`ctx.medicalCase` 与 `ctx.tools`，并注册一个不接受参数的面向模型工具。

### 为什么需要显式的读取工具

持久领域状态和对话历史是两回事，差异只在二者不一致时才显形。依赖历史来"记住"病例的 agent，会在 compaction 之后、恢复之后，或在记录被它已经看不到的东西更新之后记错。调用本工具是用记录本身来回答问题。

被否决的替代方案——把病例注入系统提示词或每个请求——在 Phase 2 不予采纳：系统提示词是请求前缀，每轮变化的值会让**每一轮**的 KV 缓存复用失效，而且它会把已记录的事实混进承载指令的那一层。

### 行为

| 调用 | 结果 |
|---|---|
| 会话已有病例 | 权威 `CaseView`：四个字段、`missingFields`、`revision` 与时间戳 |
| 会话尚无病例 | 指明记录缺失的错误结果，agent 应用 `medical_case_intake` 记录一份 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察约定已在[使用本包](#use-this-package)中说明；本节解释单一定义如何产生这些行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件身份、空参数根、输出 schema 与渲染 |
| — | 不发布运行时不变式伴生入口：本工具不拥有任何生命周期流，也不追加自己的会话事件，因此没有需要核对的独立观测。 |

### 消费方角色

插件注入 `['agents', 'medicalCase', 'tools']` 并只注册一个 `defineTool` 条目。它从执行信息中解析调用方 agent，并委托给 `ctx.medicalCase.require`——后者读取 host-only 的 `medicalCase` 投影，并在该次读取中从当前状态派生 `missingFields`。工具本身不缓存任何状态。

### 注册

工具没有参数，因此投影出的参数根对象没有属性、也没有 `required` 列表。参数校验仍然经过注册表的分发路径，这也正是无 agent 执行会以普通工具错误失败、而不是从插件里抛出的原因。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [医疗接诊病例领域](../medical-case/README.zh.md)——本工具读取的状态，以及 `missingFields` 背后的派生逻辑。
- [接诊工具](../tool-medical-case-intake/README.zh.md)——记录首次接诊病例。
- [更新工具](../tool-medical-case-update/README.zh.md)——变更已记录的病例。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-get)——生成的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`medical_case_get` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-get)：空参数对象、没有 `required` 列表，外加一段说明——结果是权威的，来自持久会话状态而不是对话记忆。

#### Token 影响

工具可见时每个请求的固定 schema 开销；因为不声明任何参数，它是三个病例工具里最小的。

#### KV Cache 影响

只要定义与其可见性不变，前缀保持稳定。注册、卸载或限制该工具可能使从此 schema 起的复用失效。

### 工具调用历史与结果

#### 模型看到什么

结果是渲染后的记录：四个字段、`missingFields` 与 `revision`；会话无病例时是确切的 `Error: <message>` 行。规范结构化值不展示，只有渲染文本。

#### Token 影响

每次调用一个结果，保留到 compaction。完整记录约渲染七行。

#### KV Cache 影响

追加式；结果跟在可复用请求前缀之后，不会使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **构造上即只读**——本工具无法恢复更早的修订、列出历史修订，也无法报告某个字段何时改变。修订历史在会话日志里，但没有在此暴露。
- **每会话一个病例**——调用读取的是本会话的当前病例；无法按身份或跨会话查找病例。
- **渲染的是整个病例**——没有字段选择，只要一项的调用方也要为全部付费。
- **没有自动注入**——必须由模型主动询问；没有任何东西会自行把记录放进请求。评估见[使用本包](#use-this-package)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

三个病例工具是各自独立的包，而 `tool-goal` 在一个包里装了三个工具。这个拆分遵循 Phase 2 定下的边界，也让 `medical_case_get` 能单独挂载——只读部署可以提供记录而不提供任何修改它的途径。

</details>
