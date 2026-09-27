---
description: "面向模型的 medical_image_get 工具：按附件读取会话已经记录的权威图像观察。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-medical-image-get

[English](README.md) | 中文

## 摘要

`medical_image_get` 读取本会话已经记录的图像观察。这是显式读取路径：观察是能挺过 resume 与 fork 的持久会话状态，所以需要它的 agent 到这里来问，而不是靠对话历史去「记得」自己看过什么。

读取按附件寻址，绝不按时间先后。一个会话可以持有多张图，而一个只返回最新一张的 API，会在第三张到来时让第二张立刻不可读。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

---

<a id="use-this-package"></a>
## 使用本包

把它挂在图像领域与观察工具旁边。

```yaml
- id: tool-medical-image-get
  name: '@deepseek-ai/dsh-tool-medical-image-get'
```

### 参数

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `attachmentId` | 否 | 读取某一个附件。省略则列出本对话中观察过的全部图像。 |

### 结果

结果**始终是列表**，所以一种调用形状同时覆盖两种读法。指定一个本会话没有观察记录的附件会以 `IMAGE_OBSERVATION_NOT_FOUND` 失败，而不是返回空列表——空列表与「从未观察过任何东西」无法区分。

读取不改变任何东西：不追加事件，也不推动 revision。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件身份、可选参数根、列表输出 schema 与渲染 |
| — | 不发布 runtime invariant companion：本工具只读取 projection，不追加任何东西，因此没有可对账的独立观察。 |

<a id="further-exploration"></a>
## 进一步探索

- [医学图像领域](../medical-image/README.zh.md) —— service、事件与授权规则。
- [观察工具](../tool-medical-image-observe/README.zh.md) —— 本工具读回的那条写入路径。
- [病例读取工具](../tool-medical-case-get/README.zh.md) —— 患者陈述那一半的同款读取模式。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`medical_image_get` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-image-get)：一个可选的 `attachmentId` 与一个列表输出 schema，因此一种调用形状同时覆盖「读某一张图」与「列出全部已观察图像」。

#### Token 开销

在工具可见的每个请求上都有固定 schema 成本；它是两个图像工具中较小的一个，因为它只声明一个可选参数。

#### KV Cache 影响

在定义与其可见性不变的前提下，prefix 保持稳定。注册、释放或限制该工具，都可能让从此 schema 起的复用失效。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **除附件 id 外没有过滤** —— 无法按部位、按可用性或按 revision 查询。
- **没有观察的历史** —— 读取返回当前 revision。更早的 revision 仍留在 session log 里，但本工具触达不到。
- **不跨会话** —— 本工具只读调用方自己的会话，来自其它会话的附件就是「不存在」。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

列表形状是刻意的。「取最新一条观察」的工具读起来更简单，却会悄悄丢掉每一张更早的图——而这正是本阶段「多图」要求存在的原因。

</details>
