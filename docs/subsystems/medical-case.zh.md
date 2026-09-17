# 医疗接诊病例

[English](medical-case.md) | 中文

事件溯源病例服务及其消费方共享的类型。本页记录 [`packages/medical/medical-case/src/types.ts`](../../packages/medical/medical-case/src/types.ts) 中的确切字段与变体。

## 标识与生命周期

`CaseId` 是[品牌化 id](core.zh.md#branded-ids)。调用方通过 `CaseRef` 引用一个确切的修订版本；每次获准的持久变更都会递增修订号。

```ts type-equiv
/** Compare-and-set identity for one exact case revision. */
interface CaseRef {
  /** Stable case identity. */
  readonly caseId: CaseId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}
```

一个会话最多只有一份当前病例，而且病例一旦建立，其身份在整个生命周期内保持不变。只有 `create` 会生成新身份并从修订号一开始；此后每次变更都必须保持该身份并把修订号恰好推进一。

```ts type-equiv
/** Durable state-changing verbs recorded in the case log. */
type CaseOperation = 'create' | 'update'
```

## 持久状态

每次变更都会写入完整的持久状态，绝不写增量。读取方只看到最近一条记录就能得到权威结果，因此投影与严格回放都不需要更早的历史。

```ts type-equiv
/** The complete durable case state. */
interface CaseState extends CaseRef {
  /** Symptoms exactly as recorded, in first-seen order. */
  readonly symptoms: string[]
  /** Free-text duration, or null while unrecorded. */
  readonly duration: string | null
  /** Whole years of age, or null while unrecorded. */
  readonly age: number | null
  /** Optional context, or null while unrecorded. */
  readonly additionalNotes: string | null
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation; never decreases. */
  readonly updatedAt: number
}
```

症状在写入时归一化：逐项 trim、丢弃 trim 后为空的项、按 trim 后的文本去重，并保留首次出现的顺序。`duration` 与 `additionalNotes` 是自由文本；空白只在创建路径上表示"尚未说明"，在变更路径上会被拒绝，因此任何调用方都不会意外清空已记录的事实。

`age` 是整年数，因此 `0` 合法，表示不足一岁的婴儿。

## 读模型与派生值

缺失字段是**派生值**，不是持久字段。`deriveMissingFields` 从当前状态现算，所以"已记录的字段"和"缺口报告"在结构上不可能互相矛盾。

```ts type-equiv
/** The read model: durable state plus values derived from it. */
interface CaseView extends CaseState {
  /** Required facts absent from this revision. */
  readonly missingFields: MissingField[]
}
```

```ts type-equiv
/** A fact the agent still has to obtain before the intake is complete. */
type MissingField = 'symptoms' | 'duration' | 'age'
```

`additionalNotes` 是可选上下文：它的缺失永远不会出现在 `missingFields` 里。

## 变更请求

首次接诊请求的每个字段都可以省略：记录"用户还没说"是一个成功的、有用的结果，而不是一次参数错误。

```ts type-equiv
/** First-contact input. Every field may be omitted. */
interface CaseIntakeRequest {
  /** Symptoms the user named; omit when none were named. */
  readonly symptoms?: string[]
  /** How long the symptoms have lasted, as the user phrased it. */
  readonly duration?: string
  /** Patient age in whole years. */
  readonly age?: number
  /** Any other case context the user volunteered. */
  readonly additionalNotes?: string
}
```

增量变更对已存在的病例生效。省略的字段保持原值；没有任何参数会静默清空一个字段。

```ts type-equiv
/** Incremental change against an existing case. */
interface CasePatch {
  /** Replace the whole symptom list. Mutually exclusive with the two deltas. */
  readonly symptoms?: string[]
  /** Append these symptoms, preserving the ones already recorded. */
  readonly symptomsAdd?: string[]
  /** Drop these symptoms; a value that is not recorded is a no-op. */
  readonly symptomsRemove?: string[]
  /** Replacement duration text. */
  readonly duration?: string
  /** Replacement age in whole years. */
  readonly age?: number
  /** Replacement optional notes. */
  readonly additionalNotes?: string
}
```

`symptoms` 与两个增量参数互斥；`symptomsAdd` 与 `symptomsRemove` 可以同时出现，但同一个归一化后的症状不能同时出现在两侧。空症状列表与空白字符串都会被拒绝：清空已记录的病例不是任何后续句子的含义。

```ts type-equiv
/** Outcome of one accepted patch attempt. */
interface CaseUpdateResult {
  /** The authoritative case after the attempt. */
  readonly view: CaseView
  /** Whether the attempt produced a durable new revision. */
  readonly changed: boolean
}
```

一次没有造成任何实质变化的变更不会追加事件，也不递增修订号，因此 `changed` 为 `false` 时修订号与 `updatedAt` 都停在原处。

## 服务行为

[`MedicalCaseService`](../../packages/medical/medical-case/src/index.ts) 只接受在注册表中以对应 id 注册的同一个实时 `Agent` 对象，从 `ctx.sessionProjections` 的 `medicalCase` 投影读取严格回放结果，并追加完整的 `medical/case-change` 会话事件。它不拥有任何存储：持久化、恢复与 fork 继承都属于会话日志。

阻塞式失败有两个来源。严格解码拒绝任何形状不符或前后不一致的记录，并把失败闩锁在投影状态上，因此后续读取报告同一个持久故障而不会静默跳过。领域边界则用稳定的错误码拒绝无效请求。包 [README](../../packages/medical/medical-case/README.zh.md) 定义可调用 API 与面向模型的约定。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmedicalcase--medicalcaseservice"></a>

### `ctx.medicalCase` — `MedicalCaseService`

The medical intake case service (`ctx.medicalCase`), backed exclusively by the owning session log. Every mutation appends a full-state `medical/case-change` event and returns the resulting authoritative view; a mutation that would change nothing appends no event and keeps the revision.

```ts cordis-catalog
/**
 * Read the current case for one exact live agent.
 * @param agent - owning live agent.
 * @returns a fresh view, or `undefined` when no case has been recorded.
 * @throws {@link MedicalCaseError} when the agent is not the registry's live instance.
 */
get(agent: Agent): CaseView | undefined

/**
 * Read the current case, failing when this session has none.
 * @param agent - owning live agent.
 * @returns a fresh view.
 * @throws {@link MedicalCaseError} when no case exists or the agent is not live.
 */
require(agent: Agent): CaseView

/**
 * Record the first-contact case for one exact live agent.
 * @param agent - owning live agent.
 * @param request - the facts the user has volunteered so far; any may be omitted.
 * @returns the created view at revision one.
 * @throws {@link MedicalCaseError} when a case already exists.
 */
create(agent: Agent, request: CaseIntakeRequest): CaseUpdateResult

/**
 * Record what the user just described. Creates the case when the session has
 * none, and otherwise treats the request as a restatement of the record.
 * @param agent - owning live agent.
 * @param request - the facts the user volunteered in this message.
 * @returns the authoritative view and whether it changed.
 */
intake(agent: Agent, request: CaseIntakeRequest): CaseUpdateResult

/**
 * Apply one incremental patch to the current case.
 * @param agent - owning live agent.
 * @param patch - the change; an omitted field keeps its recorded value.
 * @returns the authoritative view and whether it changed.
 * @throws {@link MedicalCaseError} when no case exists or the patch is invalid.
 */
applyPatch(agent: Agent, patch: CasePatch): CaseUpdateResult
```

Types: [Agent](core.zh.md)

Source: [`packages/medical/medical-case/src/index.ts`](../../packages/medical/medical-case/src/index.ts)
<!-- END GENERATED cordis-surface -->
