---
description: "dsh web 客户端的 MedHarness 接诊页：右侧栏 tab，把患者陈述的记录与模型观察的图像证据并排展示，两块面板从不共用强调色。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-medharness

[English](README.md) | 中文

## 概述

MedHarness 接诊页：一个右侧栏 tab 类型，回答两个在问诊对话里很难核对的问题 —— 我到底告诉过它什么，它又从我的照片里看到了什么。它只注册一个 tab 类型、它的文案与它的主体，别无其他：它绘制的两个值都是宿主已经折叠好的会话投影，因此浏览器不贡献任何自己的数据通路。

## 目录

- [注册了什么](#what-it-registers)
- [两块面板](#the-two-panels)
- [数据从哪里来](#where-the-data-comes-from)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

三项贡献，全部走公开席位：

| 席位 | 放入什么 |
|---|---|
| `ctx.sidebarRightTabs` | `medharness` tab 类型，从右侧栏的引导页可达 |
| `sidebar.right.pane.tab` | 主体，以本包的 id 为键 |
| `ctx.locale` | `medharness` 命名空间词典 |

它不贡献 Remote 命名空间、不贡献 store、不贡献宿主行。node 半边是空的 `apply()`，只为让该插件出现在浏览器花名册所扫描的宿主树里。

<a id="the-two-panels"></a>
## 两块面板

**您提供的信息** 绘制用户陈述的病例：症状、持续时间、年龄、可选补充说明、当前修订号，以及一个三项的完整度列表。完整度列表完全由宿主的 `missingFields` 驱动 —— 浏览器从不自行判断缺什么，因此指示器不可能与它所描述的记录不一致。

**图像观察结果** 为每张附加图像绘制一张卡片：显示名（附件没有名字时回退为位置式标签）、修订号、部位、可见发现、质量问题，以及模型无法判定的内容。无法评估的图像作为一种**结果**展示 —— 「这张照片无法可靠评估」是有用信息，也正是用户能去重拍一张的原因。

两块面板从不共用强调色，且每个区块都带一个 `data-evidence` 属性，标明它承载的是哪一类证据。这是设计而非装饰：把「用户说了什么」与「模型看到了什么」区分开，正是把它们并排展示的全部理由，而合并成一张列表恰好会摧毁这个区分。两块面板都没有结论行，因为领域里没有诊断、严重程度或风险字段可以放进去。

<a id="where-the-data-comes-from"></a>
## 数据从哪里来

两个值都是**通过框架标准套件读取的会话投影**：

```ts
const reported = useProjection('medicalCase')
const observed = useProjection('medicalImage')
```

宿主从会话日志折叠每个键并发布完成后的值；客户端只是保存它，从不折叠任何东西。这就是为什么刷新、resume 与第二台设备会显示同一个页面 —— 也是本包没有数据获取代码、没有 store、没有刷新逻辑的原因。

两个键由领域包声明（`dsh-medical-case/client`、`dsh-medical-image/client`），它们同时发布宿主用来校验每个值的 `wire` 面。

<a id="model-experience"></a>
## Model Experience

无。本包不贡献工具、不贡献提示词段落、不贡献宿主行为；它做的任何事都不可能出现在模型请求里。

#### KV Cache effect

无。本包不向请求前缀添加任何内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

**页面读的是投影，不是对话记录。** 如果某个会话的日志早于 `wire` 面出现，宿主就不会为这些键发布任何值，页面会显示加载行而不是报错。因此本阶段之前写入的会话需要先产生新一轮对话才会渲染。

**除三项必填事实外没有进度条。** 完整度列表精确镜像 `missingFields`，所以增加必填字段的部署会看到它自动出现、无需改代码，但没有百分比或步骤指示。

**没有图像缩略图。** 每张卡片是命名这张图而不是渲染它。客户端可以通过既有附件流水线拿到字节，缩略图渲染是自然的下一步，本阶段没有做。

**tab 从引导页打开。** 会话开始时不会自动打开它；想让默认固定的部署需要一个本包不拥有的 tab 导航默认值。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包之所以小，是因为难的部分被刻意放在了别处。让医疗投影发布 `wire` 面 —— 而不是新增一个 Remote 读 API —— 意味着浏览器通过既有的 follow 流拿到完成值，于是实时更新、resume 与刷新都无需一行客户端代码。另一条路则需要新的 RPC 命名空间、一套轮询或失效机制，以及第二个会让两个领域形状漂移的地方。

组件以 props 接收值且不持有状态。这正是刷新场景可以被测成「两次挂载相等」而不是一个剧本的原因。

</details>
