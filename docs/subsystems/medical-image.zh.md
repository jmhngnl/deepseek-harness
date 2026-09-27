# 医学图像观察

[English](medical-image.md) | 中文

一次医疗问诊中「模型观察到」的那一半。会话里患者陈述的事实属于[医疗接诊病例](medical-case.zh.md)；模型在一张附加图像里看到的内容属于这里。两者刻意是两个独立领域：可见发现是证据，不是患者说过的话，本领域里没有任何东西能触达病例字段。

本领域不自带任何存储。每一条观察都是一条持久的 `medical/image-observation` 会话事件，当前值是对这些事件做的 projection，因此持久化、resume 与 fork 继承都来自 session log，而不是第二份存储。

## 身份与生命周期

一条观察由它的附件标识。`ImageAttachmentRef.attachmentId` 是内容寻址的，所以一张图不可能以两个身份被观察，再加一个 id 字段只会多出一个需要保持一致的键。一个会话里的多张图就是多条观察，各自按自己的附件寻址。

一个会话可以持有许多条观察。这里刻意没有单一的「当前」观察：单槽存储会在第三张图到来时让第二张立刻不可读。

观察本身不可变。什么都没记录的新陈述不写事件；改变了已记录字段的陈述写一条，并把 revision 推进一格。

## 持久状态

每次变更写入完整的观察，而不是补丁：

| 字段 | 含义 |
| --- | --- |
| `attachment` | canonical 的 `ImageAttachmentRef`，取自会话自己的用户消息 |
| `revision` | 正数；该附件首次被观察时为 1 |
| `bodyRegion` | 图像所示部位，按观察者的说法，或 null |
| `findings` | 直接可见的发现，按首次出现顺序，无重复 |
| `quality` | 图像是否可被描述，以及限制它的因素 |
| `uncertainty` | 观察者从这张图无法判定的内容 |
| `createdAt` / `updatedAt` | 首次与最近一次观察的 epoch 毫秒 |

没有置信度、没有严重程度、没有诊断。契约里没有字段可容纳临床结论，产生观察的那个工具也没有命名任何一个。

质量联合是封闭的——`blur`、`poor_lighting`、`occlusion`、`too_distant`、`unable_to_assess`——并且 issues 按 canonical 顺序存储。需要另一个限制的部署应该抬高载荷版本，而不是发送自由文本，这样两次记录同一限制的运行才可比较。

## 授权

canonical 引用从不来自调用方。`observe` 接受一个 attachment id，对着会话派生出的模型可见转录解析，并持久化会话自己那条消息所携带的引用。

本会话从未携带过的 id 会被拒绝，属于另一个会话的 id 同样被拒绝：两者都回答 `IMAGE_ATTACHMENT_NOT_IN_SESSION`，因为区分它们等于报告别处存在哪些 id。同一附件出现多次时，按派生消息顺序取第一次出现；这既是确定性的，也不会改变被存储的值，因为内容寻址的同一个 id 的每一次出现描述的都是同一个不可变对象。

## 服务行为

[`MedicalImageService`](../../packages/medical/medical-image/src/index.ts) 只接受在其 id 下注册的那个确切的存活 `Agent` 对象，从 `ctx.sessionProjections` 上的 `medicalImage` projection 读取严格重放结果，并追加完整的 `medical/image-observation` 会话事件。它从不读取图像字节，也从不调用模型：VLM 已经看过那张图了，这正是图片出现在它请求里的原因。

失败从两个方向都是响亮的。严格解码会拒绝任何畸形或不一致的记录，并把失败闩进 projection 状态，因此之后的读取会报告同一个持久故障，而不是悄悄跳过它。领域边界用稳定错误码拒绝非法请求。包 [README](../../packages/medical/medical-image/README.zh.md) 定义了可调用 API 与面向模型的约定。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmedicalimage--medicalimageservice"></a>

### `ctx.medicalImage` — `MedicalImageService`

The medical image service (`ctx.medicalImage`), backed exclusively by the owning session log. Every mutation appends a full-state `medical/image-observation` event and returns the resulting authoritative observation; a restatement that changes no recorded field appends no event and keeps the revision.

The service never reads image bytes and never calls a model. Authorization is answered from the session's derived transcript, which is the same surface the model was shown: a caller can only cite an image it could actually have seen.

```ts cordis-catalog
/**
 * List every observation recorded for one exact live agent, in first-observation order.
 * @param agent - owning live agent.
 * @returns a fresh array; empty when nothing has been observed.
 * @throws {@link MedicalImageError} when the agent is not the registry's live instance.
 */
list(agent: Agent): readonly MedicalImageObservation[]

/**
 * Read one attachment's observation.
 * @param agent - owning live agent.
 * @param attachmentId - the attachment to read.
 * @returns a fresh view, or `undefined` when this session has not observed it.
 * @throws {@link MedicalImageError} when the agent is not live or the stream is invalid.
 */
get(agent: Agent, attachmentId: string): MedicalImageObservation | undefined

/**
 * Read one attachment's observation, failing when this session has none.
 * @param agent - owning live agent.
 * @param attachmentId - the attachment to read.
 * @returns a fresh view.
 * @throws {@link MedicalImageError} when nothing has been observed for it.
 */
require(agent: Agent, attachmentId: string): MedicalImageObservation

/**
 * Record what the model saw in one image the session already holds.
 *
 * The canonical reference comes from the session, never from the request: the
 * request carries only the attachment id, and a media type, byte length, or
 * dimension it may also have sent is ignored. An id this session never carried
 * is refused with {@link ImageErrorCodes.IMAGE_ATTACHMENT_NOT_IN_SESSION},
 * which is also the answer for another session's attachment — naming the
 * difference would report which ids exist elsewhere.
 *
 * A restatement that records nothing new is a no-op: no event, no revision
 * change. Any other restatement of the same attachment advances it by one
 * revision, so the revision counts durable changes rather than tool calls.
 * @param agent - owning live agent.
 * @param request - the model-supplied observation.
 * @returns the authoritative observation and whether it changed.
 * @throws {@link MedicalImageError} when the agent is not live, the attachment is
 * not in this session, or a field cannot be represented durably.
 */
observe(agent: Agent, request: ImageObservationRequest): ImageObservationResult
```

Types: [Agent](core.zh.md)

Source: [`packages/medical/medical-image/src/index.ts`](../../packages/medical/medical-image/src/index.ts)
<!-- END GENERATED cordis-surface -->
