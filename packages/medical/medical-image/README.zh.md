---
description: "会话承载的医学图像观察领域：结构化的「直接可见」所见、图像质量限制，以及按附件单调递增的 revision。"
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-image

[English](README.md) | 中文

## 摘要

`ctx.medicalImage` 拥有模型在一个会话所携带的图像里观察到的东西。它是第二个医学领域，而且刻意不是第一个：`dsh-medical-case` 记录患者陈述的内容，本包记录模型看到的内容。每一次变更都向所属 session log 追加一条完整的 `medical/image-observation` 事件，并从注册表驱动的 projection 读回当前值，因此持久化、resume 与 fork 继承都来自 harness，而不是第二份存储。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

---

<a id="use-this-package"></a>
## 使用本包

本领域是一个 host service。把它挂在拥有 profile 的那一层，并挂载与它对话的工具。

### 两个领域，一个会话

```
Medical Consultation
├── Patient Report      → medicalCase  → medical/case-change
└── Model-observed Evidence → medicalImage → medical/image-observation
```

两者永不互相写入。本包里没有任何代码 import 病例领域，也没有任何路径能触达 `CaseState`：可见发现是证据，而发现不是患者说过的话。`medical-image` 自己的测试套件会断言：记录一次观察之后，病例记录与病例事件流原封不动。

### 授权：会话才是权威

`observe` 只接受一个 attachment id，除此之外什么都不信。canonical 的 `ImageAttachmentRef`——media type、字节长度、宽高——取自会话自己的用户消息，而不是调用方，因此调用方无法为 harness 从未接收过的图像断言元数据。

```
attachmentId
  → agent.session.deriveMessages()      (the model-visible transcript)
  → the first USER message carrying that attachment
  → the canonical ImageAttachmentRef     (persisted)
```

本会话从未携带过的 id 会被拒绝，属于另一个会话的 id 同样被拒绝：两者都回答 `IMAGE_ATTACHMENT_NOT_IN_SESSION`，因为区分它们等于报告别处存在哪些 id。

### revision 语义

| 情形 | 结果 |
| --- | --- |
| 某个附件的首次快照 | 一条 `observe` 事件，revision 1 |
| 完全相同的快照再来一次 | **不写事件**，revision 不变 |
| 记录了任何不同内容的快照 | 一条 `update` 事件，revision + 1 |
| 一个会话里的多个附件 | 各自一条观察，按附件寻址 |

revision 计的是持久变更次数，不是工具调用次数，所以一次什么都没记录的新陈述无法把它灌大。

### 请求是完整快照

`ImageObservationRequest` 携带每一个字段，且 `bodyRegion` 必填但可为 null。这里没有 patch 形态，也没有「保留旧值」的行为，所以一次省略了某条发现的新陈述会把它移除。这与持久事件一致：事件携带的是完整观察而不是增量——线上契约与日志现在说的是同一件事。

`bodyRegion` 必填而非可选，是为了让「无法陈述任何部位」以显式 null 记录下来，而不是与「调用方漏了这个字段」无法区分。空白字符串是第三种情况，会被拒绝。

### 附件在 update 之间不可变

只有观察可以变。`sameAttachmentRef` 比较引用的每一个字段——包括可选的 `name` 或 `originalDimensions` 是否存在，所以增删它们同样会被拒绝——fold 会拒绝任何重写其中之一的 update。该检查排在 revision 检查之前，所以一份被重写的图像会被报告成「被重写的图像」，而不是「revision 写错了」。

这条规则归 fold 所有，因为它是唯一还能同时看到引用两个版本的地方：update 一旦应用，较早的那份就从 projection 里消失了，而重放从不访问附件服务。持久流必须能独立判定。

### 读取

`list` 按首次观察顺序返回全部观察；`get` 与 `require` 按附件读一条。这里刻意没有「当前观察」：单槽设计会让第二张图在第三张到来时立刻不可读。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码地图

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 纯词汇，以及 `medicalImage` projection-key 声明的唯一归属地 |
| `domain.ts` | 持久变更载荷与稳定拒绝码 |
| `runtime.ts` | 版本常量、质量联合、领域错误 |
| `observation.ts` | 纯归一化与 no-op 比较 |
| `fold.ts` | 严格解码与重放 fold |
| `index.ts` | `MedicalImageService`、projection 单元、附件解析 |
| — | 不发布 runtime invariant companion：校验持久流的那套 fold 就是 projection 注册表所驱动的那套 fold，因此同一关系不存在可能分叉的第二种观察。 |

### 为什么事件携带整份观察

每次变更都写入完整的 `MedicalImageObservation`，包含 canonical 附件引用与 revision。只 fold 最新事件的读者依然握有权威记录，冷重放也永远不需要转录：仅凭持久流就能回答「观察了什么、在第几个 revision、属于哪张图」。

### 严格重放

`decodeMedicalImageChange` 会拒绝一切它无法精确解释的内容：不支持的版本、未知操作、空白或未规范化的字符串、不在允许集合内的 media type、非正的尺寸、不在联合内的质量问题、顺序不 canoncial 或重复的 issues，以及早于自身创建时间的 update。projection 单元会闩住第一个失败并在之后每次读取时报告，而不是跳过该记录——一个读不懂自己流的存储，不该看起来像一个什么都没记录的存储。

### 时钟在哪里读取

`Date.now()` 只在 service 边界读一次，且只在那里。fold 会校验 update 永不把变更时间往回拨，这让重放保持确定性，又不让领域依赖一个它并不拥有的时钟。

### 为什么附件遍历放在 `dsh-llm`

解析 id 时会连同顶层块一起遍历嵌套的 tool-result 内容，用的是 `@deepseek-ai/dsh-llm` 的 `visitImageBlocks`。那个模块发布的是 harness 唯一的那套递归图片遍历，因此本消费方不会在嵌套深度上与运行时其它部分产生分歧。

<a id="further-exploration"></a>
## 进一步探索

- [病例领域](../medical-case/README.zh.md) —— 患者陈述的那一半，也是本包沿用的模式。
- [附件服务](../../attachment/attachment/README.zh.md) —— `ImageAttachmentRef` 与持久图像对象。
- [LLM 内容助手](../../llm/llm/README.zh.md) —— `visitImageBlocks`、图片投影、纯文本占位符。
- [MedHarness 运行时](../../../medharness/README.zh.md) —— 挂载本领域的那个组合。

<a id="model-experience"></a>
## 模型体验

无。本包不注册任何模型可见内容：它发布一个 host service 和一个 projection，与之对话的工具是独立包。projection 是 host-only 的，因为 fold 出来的值携带临床自由文本与持久附件引用。

#### KV Cache 影响

无。这里没有任何东西进入请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **每个附件一条观察** —— 附件就是身份，所以对同一张图的第二次、不同用途的观察会替换第一条，而不是并排存在。多张图可以；对一张图的多种读法还不行。
- **没有跨图综合** —— 一条观察描述一张图。没有任何东西把两张图相互关联，也没有任何东西把观察与病例关联起来。
- **质量联合是封闭的** —— 五个具名限制，随载荷一起版本化。需要另一个限制的部署应该抬高载荷版本，而不是发送自由文本。
- **没有置信度、严重程度或诊断** —— 这是设计使然，并由契约强制：没有字段可容纳临床结论，工具 schema 也没有命名任何一个。
- **还没有聚类或打分** —— 观察被记录并读回；尚无聚合、趋势或对比。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包**未触碰** `packages/core/**`。它需要的一切——`AttachmentStore`、`ImageAttachmentRef`、`ImageBlock`、`Session.deriveMessages()`、`SessionProjectionRegistry`——都已存在。

授权接缝是 `Session.deriveMessages()`，**不是** `snapshotEvents()`。同步历史读取器（`eventAt`、`snapshotEvents`、`ownEvents`）已被 [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md) 禁止新调用；`packages/api/session-controller` 里更早的 `imageBlockIn` / `referencedImage` 就建在那个已废弃的读取器上，不是可以照抄的样板。

`src/index.ts` 不是纯再导出模块——它承载 service 与 projection 单元——所以逐文件覆盖率门禁对它完整生效。

</details>
