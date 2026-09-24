---
description: "medical 组地图：面向医疗咨询与辅助分诊的领域能力——一个会话内持久病例领域及其模型工具，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/medical

[English](README.md) | 中文

## 概述

medical 组承载构建在 harness 之上的医疗咨询与辅助分诊领域能力。与 harness 的能力分组不同，这些包不解决 agent 运行时的任何问题：它们处理的对象是病例而不是代码库。本组现在包含一个会话内持久病例领域 `medical-case`，以及三个面向模型的工具，用于记录该病例、增量变更它、以及只读地读回它。病例是问诊信息收集状态：领域记录、更新并回放用户说过的事实，报告仍然缺失的内容，让 agent 去提问而不是猜测。这里不包含任何诊断、用药或风险判断能力。

## Table of Contents

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`medical-case`](medical-case/README.zh.md) | 每会话一个持久病例：创建、重述、增量变更、严格回放与单调递增修订号 | `ctx.medicalCase` |
| [`tool-medical-case-intake`](tool-medical-case-intake/README.zh.md) | 首次联系时记录病例，并报告仍然缺失的必填字段 | 注册到 `ctx.tools` |
| [`tool-medical-case-update`](tool-medical-case-update/README.zh.md) | 对已记录病例应用一次增量变更，绝不静默清空字段 | 注册到 `ctx.tools` |
| [`tool-medical-case-get`](tool-medical-case-get/README.zh.md) | 只读地读回权威病例与仍然缺失的字段 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [医疗接诊病例子系统](../../docs/subsystems/medical-case.zh.md)——病例状态、持久事件与服务 API。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-medical-case-intake)——模型接收的三个 schema。
- [同会话目标领域](../goal/README.zh.md)——本组遵循的同类模式：事件溯源会话内状态。
- [工具编写参考](../../docs/cookbook/adding-a-tool.zh.md)——这些包遵循的工具约定。
- [包分组](../README.zh.md)——本组在 harness 能力分组中的位置。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

领域包刻意不导入 `dsh-agent-loop`：病例状态与策略通过插件、`Agent` 动词和会话事件组合，无需给默认循环实现一份特权副本——这与同会话目标领域被否决的理由相同。持久化、恢复与 fork 继承全部属于会话日志；本组不附带任何数据库或隐藏的 JSON 存储。

</details>
