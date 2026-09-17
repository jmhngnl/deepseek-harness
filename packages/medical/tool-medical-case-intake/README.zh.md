---
description: "面向模型的 medical_case_intake 工具：把用户主动提供的病例基本信息记录进本会话的持久病例，并报告仍然缺失的必填字段。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-case-intake

[English](README.md) | 中文

## 概述

`medical_case_intake` 把用户主动提供的病例事实——症状、病程、年龄与可选备注——记录进本会话的持久病例，并报告还有哪些必填事实缺失。它的目的是让 agent 去提问而不是猜测：信息缺失是一次成功的结果，列出缺口；而参数类型错误只是普通工具错误。病例已存在时，该调用是**重述**记录而不是再开一份。该工具只做记录与结构化：它不诊断疾病、不推荐治疗或药物，也不给出医学风险结论。

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

在需要让 agent 先记录病例基本信息再做其他事的地方挂载本插件。它需要 `ctx.agents`、`ctx.medicalCase` 与 `ctx.tools`，并在根平面挂载时注册一个全局工具；scope 挂载则只为该 scope 注册。病例属于调用方 agent 的会话，因此没有归属 agent 的调用会以普通工具错误失败。

### 两种结果被刻意区分

这正是该工具存在的理由，也是没有任何参数被标为必填的原因：

| 模型发送 | 含义 | 结果 |
|---|---|---|
| `{}` | 用户什么都还没说 | 成功，`missingFields` 列出每个必填字段 |
| `{"symptoms": "headache"}` | 模型把调用写坏了 | 错误结果，`isError: true` |

把 `symptoms`、`duration` 或 `age` 标为必填会把第一种情况塌缩成第二种：harness 无法区分"用户没说"和"模型弄坏了 schema"，agent 也就失去了提出有用追问的能力。

### 模型拿回什么

成功调用总是返回**完整的权威记录**，而不只是它这次提供的字段。缺失的事实是显式的 `null`（症状为 `[]`），因此形状永不变化；`missingFields` 在本次读取中从这些值派生；`revision` 标识本次调用产生的记录：

```json
{
  "caseId": "…",
  "revision": 1,
  "symptoms": [],
  "duration": null,
  "age": null,
  "additionalNotes": null,
  "createdAt": 0,
  "updatedAt": 0,
  "missingFields": ["symptoms", "duration", "age"],
  "changed": true
}
```

`additionalNotes` 按契约是可选：省略它永远不会出现在 `missingFields` 里。

### 创建病例，或重述它

第一次调用在修订号一上创建病例。之后的调用是重述：它提供的字段替换已记录的值，它省略的字段保持原值。`changed: false` 表示这次重述与记录完全一致，因此没有追加任何东西，修订号也没有移动。

只有在无东西可失去时，空白才被容忍。在创建路径上，空白 `duration` 记录为 `null` 并被报告为缺失，这正是接诊能够记录一份用户几乎还没描述的病例的方式。一旦病例存在，同样的空白只可能抹掉已记录的事实，因此会被拒绝，并在错误信息中点名字段——空症状列表同样如此。除用真实值刻意替换外，没有任何操作会清空已记录的事实。

对于补充回答，优先使用 [`medical_case_update`](../tool-medical-case-update/README.zh.md)：它的症状增量不会像重述那样丢失已记录的症状。

### 年龄规则

`age` 是整年数，因此 `0` 合法，表示不足一岁的婴儿。参数 schema 里的 `integer` 会在 schema 边界拒绝小数；范围（`0`–`130`）无法在 schema DSL 中表达，因此由领域强制，违反时调用以错误结果失败。

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
| — | 不发布运行时不变式伴生入口：本工具不拥有任何生命周期流，持久校验由领域自己的严格折叠承担。 |

### 消费方角色

插件注入 `['agents', 'medicalCase', 'tools']` 并只注册一个 `defineTool` 条目。它从执行信息中解析调用方 agent，并把每一项 merge、修订与校验决策委托给 `ctx.medicalCase.intake`。一次调用的持久痕迹是 agent loop 记录的 `tool/call` + `tool/result` 事件对，以及变更被接受时领域追加的 `medical/case-change` 事件。

### 为什么参数根是开放的

schema DSL 把 `parameters` 编译成一个隐式**开放**的对象根，因此带有无法识别顶层属性的调用会被接受，而该属性被丢弃。这是注册表级约定，不是本包的选择；它记录在[已知限制](#known-limitations-and-deferred-work)中。

### 各拒绝发生在哪里

参数类型由 `defineTool` 在工具体运行之前检查，因此写坏的调用不会到达这段代码。年龄范围与全部 merge 规则由领域强制，并给出稳定错误码，注册表把它作为模型可见的错误结果上报。两条路径都不会中断轮次。

### 渲染

`output.render` 列出四个字段、`missingFields` 与 `revision`，在无变化时明确说明，并对缺失值使用 `(none provided)` / `(none)`。规范值保持结构化，也是 PTC 程序收到的值；渲染文本的存在是为了让模型无需解析就能读到缺口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [医疗接诊病例领域](../medical-case/README.zh.md)——本工具所记录进的持久状态。
- [更新工具](../tool-medical-case-update/README.zh.md)——补充回答的增量路径。
- [读取工具](../tool-medical-case-get/README.zh.md)——显式读取路径。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-intake)——生成的 `medical_case_intake` schema。
- [工具编写参考](../../../docs/cookbook/adding-a-tool.zh.md)——本包遵循的 `defineTool` 契约。
- [医疗分组地图](../README.zh.md)——本工具所属的兄弟包。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`medical_case_intake` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-intake)：四个可选参数，每个都自我描述，没有 `required` 列表。工具描述写明了非目标——不诊断、不推荐治疗或药物、不评估风险——把补充回答指向 `medical_case_update`，并指示模型追问 `missingFields` 中列出的字段。

#### Token 影响

工具可见时每个请求的固定 schema 开销。四个参数描述占了主要部分。

#### KV Cache 影响

只要定义与其可见性不变，前缀保持稳定。注册、卸载或限制该工具可能使从此 schema 起的复用失效。

### 工具调用历史与结果

#### 模型看到什么

模型自己的参数留在 assistant 工具调用块里。结果是渲染后的记录（含四个字段、`missingFields` 与 `revision`），或对于被拒绝的调用是确切的 `Error: <message>` 行。规范结构化值不展示，只有渲染文本。

#### Token 影响

每次调用一个结果，保留到 compaction。字段为空的记录约渲染七行；描述不会在结果中重复。

#### KV Cache 影响

追加式；结果跟在可复用请求前缀之后，不会使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **参数根是开放的，无法识别的顶层属性会被静默忽略**——拼错的字段名会被读成"用户没说"，而不是坏调用。封闭它在参数 DSL 中无法表达；更严格的契约需要一个 `additionalProperties: false` 的包装对象参数。
- **重述会替换症状列表**——intake 是"这里是全貌"的路径，因此提供更短列表的调用会丢掉缺失项。`medical_case_update` 是补充回答的安全路径，其描述也如此说明；但这里没有任何机制强制这一选择。
- **单个症状只做归一化**——trim、去空白、去重，但不映射到受控词表，因此 `"Fever"` 与 `"fever"` 仍然不同。
- **`duration` 保持自由文本**——会 trim 但从不解析为归一化区间，因此 `"2 days"` 与 `"48 hours"` 不可比较。
- **`age` 只接受整年**——婴儿用 `0` 表示，没有出生日期或月粒度输入。
- **每会话一个病例**——没有可用于跨会话关联就诊的病例身份，也无法记录并发的第二份病例。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

该工具刻意保持薄。模型可能踩到的每条规则——互斥、空白拒绝、修订单调性——都住在领域里，这样三个病例工具不会各自漂移，未来的 UI 或命令路径也能拿到同样的保证而不必重新推导。

</details>
