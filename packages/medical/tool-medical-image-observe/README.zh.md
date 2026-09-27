---
description: "面向模型的 medical_image_observe 工具：记录某张会话图像中「直接可见」的属性，连同其质量限制与无法判定的部分。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-image-observe

[English](README.md) | 中文

## 摘要

`medical_image_observe` 记录模型在一张用户附加到对话里的图像中**直接可见**的内容。模型已经看过这张图了，所以本工具不读取它、不调用模型，也不从字节重新推导任何东西。它接收模型的结构化陈述，交给 `ctx.medicalImage`，并返回权威观察。

每次调用记录的是某一张附加图像**当前完整的**观察。每个字段都必填，所以这是完整快照而不是 patch：不要为了保留旧值而省略字段。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

---

<a id="use-this-package"></a>
## 使用本包

把它挂在图像领域旁边——按 agent 或按 host 治理工具的那个 profile 里。

```yaml
- id: medical-image
  name: '@deepseek-ai/dsh-medical-image'
- id: tool-medical-image-observe
  name: '@deepseek-ai/dsh-tool-medical-image-observe'
```

### 模型提供什么

每个字段都必填。省略任何一个都是 schema 错误，而不是「保留旧值」的请求。

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `attachmentId` | string | 图片旁显示的 id。会对着本会话解析。 |
| `bodyRegion` | string **或 null** | 图像所示部位；无法陈述任何部位时显式传 null。 |
| `findings` | string[] | 全部直接可见的发现，每条一个短句。空数组是合法的。 |
| `usable` | boolean | 图像中是否有任何部分可被描述。 |
| `qualityIssues` | string[] | `blur`、`poor_lighting`、`occlusion`、`too_distant`、`unable_to_assess`。空数组是合法的。 |
| `uncertainty` | string[] | 全部无法判定的内容。空数组是合法的。 |

`bodyRegion` 刻意做成「必填且可为 null」：「无法陈述任何部位」是一件值得记录的事实，与「调用方漏了这个字段」不是一回事。空白字符串两者都不是——领域会拒绝它，而不是把它折成 null。

没有 media type、字节长度或尺寸参数，也没有诊断、疾病、治疗、药物、风险或置信度参数。前者属于 harness 该知道的，后者不是本工具该记录的。

### harness 拿它做什么

attachment id 会对着会话自己派生出的转录解析，被持久化的引用是会话的 canonical `ImageAttachmentRef`。从未在此附加过的 id——包括属于另一个会话的 id——会以 `IMAGE_ATTACHMENT_NOT_IN_SESSION` 被拒绝。引用本身在 update 之间不可变：fold 会拒绝任何重写它的持久记录。

### 完整快照，而不是 patch

持久事件是一份完整的观察，所以线上契约说的是同一件事：一次调用声明当前完整的观察。

| 调用 | 结果 |
| --- | --- |
| 某附件的第一次快照 | 一条 `observe` 事件，revision 1 |
| 逐字节相同的快照再来一次 | 不写事件，revision 不变 |
| 记录了任何不同内容的快照 | 一条 `update` 事件，revision + 1 |
| 快照省略了上一份有的一条发现 | 该发现**真的消失**：没有任何东西会保留它 |

patch 形态的工具会让模型仅仅因为忘记重复就悄悄丢掉一条发现，revision 也就不再意味着「观察者改了他的陈述」。

### 可见证据的边界

这条边界写在工具描述里，因为那正是模型在调用前读到它的地方：

- 只记录直接可见的属性——颜色、形状、大小、分布、表面外观、肿胀、变色；
- 陈述图像限制与无法判定的部分；
- 图像无法可靠评估时，把 `usable` 置为 false 并说明原因，而不是去猜；
- 不给出诊断、疾病、治疗、药物或风险判断；
- 绝不把发现重述为患者陈述的症状。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件身份、参数 schema、输出 schema 与渲染 |
| — | 不发布 runtime invariant companion：本工具不拥有任何生命周期流，也不自己追加会话事件，因此没有可对账的独立观察。 |

<a id="further-exploration"></a>
## 进一步探索

- [医学图像领域](../medical-image/README.zh.md) —— service、事件与授权规则。
- [病例录入工具](../tool-medical-case-intake/README.zh.md) —— 患者陈述的那一半，也是本工具沿用的模式。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`medical_image_observe` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-image-observe)：六个参数、其中两个必填，以及一段承载「可见证据」边界的描述——只记录直接可见的属性、陈述质量限制与无法判定的部分，绝不给出诊断、治疗或风险。什么都没记录的新提交会返回同一条记录并带 `changed: false`，模型据此能知道没有记录到新内容。

#### Token 开销

在工具可见的每个请求上都有固定 schema 成本。它是五个医疗工具中最大的一个，因为它的参数描述承载了观察词汇表。

#### KV Cache 影响

在定义与其可见性不变的前提下，prefix 保持稳定。注册、释放或限制该工具，都可能让从此 schema 起的复用失效。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **每个附件一条观察** —— 对同一张图的第二次观察会替换第一条，而不是并排存在。
- **发现是自由文本** —— 发现按模型自己的措辞记录，所以两次运行可能对同一外观给出不同描述。没有任何东西归一化措辞。
- **没有置信度，也不需要** —— 契约里没有这个字段，本阶段也不引入伪精度。
- **模型必须先看过图** —— 本工具无法描述模型没被展示过的图像，而且它刻意不去尝试：它背后没有第二次 VLM 调用。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本工具除参数搬运外不持有任何逻辑。校验、归一化、授权与持久化都在 `@deepseek-ai/dsh-medical-image` 里，因此规则无需工具注册表即可测试，也不会在两个入口之间漂移。

`qualityIssues` 由发布的 schema 约束，并在领域里**再次**校验。schema 是面向模型的那道闸；领域检查是绕过工具的直接调用方仍然会撞上的那道。

</details>
