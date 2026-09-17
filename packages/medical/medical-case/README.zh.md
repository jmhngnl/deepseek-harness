---
description: "会话内医疗接诊病例领域：持久病例状态、严格回放、比较并交换修订，以及派生的缺失字段报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-medical-case

[English](README.md) | 中文

## 概述

`ctx.medicalCase` 管理一个会话的医疗接诊病例：一次接诊记录下来的事实——症状、持续时间、年龄和可选补充说明——外加一个在每次获准变更时递增的修订号。本领域不自己存储任何东西。每次变更都向所属会话日志追加一条完整的 `medical/case-change` 事件，并从注册表驱动的投影读回当前值，因此持久化、恢复与 fork 继承都来自 harness 而不是第二份存储。缺失字段报告在读取时派生、从不持久化，所以已记录的事实与它的缺口报告不可能互相矛盾。

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

在需要让 agent 跨轮次保留结构化接诊病例处挂载本插件。它需要 `ctx.agents` 与 `ctx.sessionProjections`，两者出厂 bundle 均已提供，并注册 `ctx.medicalCase`。

### 这是服务，不是存储

病例住在会话日志里。正是这一选择让病例无需迁移就能跨重启、恢复与 fork 存活，也是本包不附带任何数据库、JSON 文件或按会话索引的内存 Map 的原因。一个会话的病例由该会话自己的事件派生，因此两个会话绝不可能共用一份。

### 读取

| 调用 | 结果 |
|---|---|
| `get(agent)` | 当前视图；无病例时返回 `undefined` |
| `require(agent)` | 当前视图；无病例时抛 `CASE_NOT_FOUND` |

两者都返回一个新的 `CaseView`：持久状态加上在本次读取中从该状态派生的 `missingFields`。

### 写入

| 调用 | 行为 |
|---|---|
| `create(agent, request)` | 记录修订号一；已存在病例时以 `CASE_ALREADY_EXISTS` 失败 |
| `intake(agent, request)` | 会话无病例时创建，否则重述记录 |
| `applyPatch(agent, patch)` | 应用增量变更；无病例时以 `CASE_NOT_FOUND` 失败 |

每次获准的变更都返回 `{ view, changed }`。当 `changed` 为 `false` 时，该调用没有追加事件，修订号没有移动，`updatedAt` 也没有移动。

```ts
const { view } = ctx.medicalCase.intake(agent, { symptoms: ['headache', 'fever'] })
// view.missingFields === ['duration', 'age']

const completed = ctx.medicalCase.applyPatch(agent, { duration: '2 days', age: 25 })
// completed.view.missingFields === []
```

### 空白规则

只有在无东西可失去时，空白字段才表示"尚未说明"。在创建路径上，空白持续时间记录为 `null` 并被报告为缺失，这正是接诊能够记录一份用户几乎还没描述的病例的方式。一旦病例存在，同样的空白只可能抹掉已记录的事实，因此会被拒绝，并在错误信息中点名字段。除用真实值刻意替换外，没有任何操作会清空已记录的事实。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察约定已在[使用本包](#use-this-package)中说明；本节解释各部分如何产生这些行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 纯值类型与 `medicalCase` 投影键声明，不含宿主侧导入 |
| [`src/domain.ts`](src/domain.ts) | `medical/case-change` 会话事件声明、折叠形状与稳定错误码 |
| [`src/runtime.ts`](src/runtime.ts) | 载荷版本、年龄上限、id 品牌与领域错误类 |
| [`src/fold.ts`](src/fold.ts) | 严格解码器与纯回放折叠 |
| [`src/patch.ts`](src/patch.ts) | 纯状态运算：归一化、patch 契约与缺失字段派生 |
| [`src/index.ts`](src/index.ts) | 服务、投影单元与读模型 |
| — | 不发布运行时不变式伴生入口：校验持久流的折叠就是投影注册表驱动的那个折叠，因此同一关系不存在可以发散的第二种观测。 |

### 为什么事件携带完整状态

`session-projection` 要求携带状态的日志事件携带变更后的完整值而不是增量。正是这条规则让 `missingFields` 得以保持派生：读取方无需回放更早记录就能知道病例当前持有什么，因此也不需要存储缺口报告来维持一致性。

### 严格回放

折叠会拒绝形状错误、修订号未恰好推进一、身份改变、创建时间变动、变更时间倒退，或重述了未变事实的记录。拒绝会闩锁进投影状态，因此此后每次读取都报告同一个持久故障，而不是悄悄跳过该记录。服务在追加之后读取投影，从而让生产者与折叠的分歧在造成它的那次变更上立即暴露。

### 时钟在哪里读

只有服务读取时钟，并把结果钳制到不小于上一次的 `updatedAt`。因此倒退的挂钟无法发布一条陈旧记录——那会被严格回放拒绝。`src/patch.ts` 把时间戳作为参数接收，所以 merge 契约是其输入的完全函数，测试它不需要控制时间。

### 注册

`ctx.sessionProjections.register(...)` 是挂在服务自身 fiber 上的 effect，因此卸载服务会移除投影键及其缓存 cell。每当序列化字段或折叠语义变化时，递增 `medicalCaseProjectionDefinition` 的 `stateVersion`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [医疗接诊病例子系统](../../../docs/subsystems/medical-case.zh.md)——确切字段、变体与服务行为。
- [会话投影](../../session/session-projection/README.zh.md)——驱动折叠并提供逐会话 cell 的注册表。
- [持久化子系统](../../../docs/subsystems/persistence.zh.md)——本领域存放记录所用的会话日志。
- [同会话目标领域](../../goal/goal/README.zh.md)——本包遵循的同类模式：带比较并交换修订的事件溯源会话内状态。
- [医疗分组地图](../README.zh.md)——本领域所服务的兄弟包。

-----

<a id="model-experience"></a>
## 模型体验

无——本包不注册任何模型可见内容：病例只通过消费它的 `medical_case_*` 工具到达模型。

#### KV Cache 影响

无；本领域从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个会话只有一个病例**——没有病例历史、没有多次就诊图、没有跨会话病例库。第二次 `create` 会被拒绝；多次就诊需要后继领域。
- **公开 API 没有比较并交换参数**——变更总是作用于当前修订，身份复用或跳过修订由折叠捕获，而不是作为乐观并发参数提供给调用方。若出现并发写入方，`GoalRef` 是模板。
- **`symptoms` 是自由文本**——会被 trim、去重并保序，但不映射到受控词表，因此 `"Fever"` 与 `"fever"` 仍然不同。
- **`duration` 保持自由文本**——会 trim 但从不解析为归一化区间，因此 `"2 days"` 与 `"48 hours"` 不可比较。
- **`age` 只接受整年**——婴儿用 `0` 表示，没有出生日期或月粒度输入。
- **没有清空操作**——已记录的病例无法被删除、清空症状或回退到更早修订。刻意擦除需要自己的动词与墓碑记录。
- **没有进程内变更通知**——消费方读取返回的视图或调用服务；没有供 UI 或审计监听器订阅的 `medical/case-changed` 事件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本领域刻意不导入 `dsh-agent-loop`。把病例状态加入默认循环之所以被否决，与目标领域被否决的理由相同：状态与策略可以通过插件、`Agent` 动词和事件组合，无需让默认循环实现获得一份特权副本。

</details>
