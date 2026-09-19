---
description: "独立的医疗接诊 profile：模型可见的工具面只有三个病例工具，不含 shell、文件系统、后台任务、目标、子代理、工作流与遥测。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-medharness`

[English](README.md) | 中文

## 概述

当 Agent 的职责只是「记录用户陈述的病例事实并追问缺失项」时，使用 `dsh --profile medharness`。该 profile 提供一个完整的 Cordis 树，并刻意排除 `dsh-base`：没有 shell、没有文件系统、没有后台任务、没有目标、没有待办、没有计划模式、没有子代理、没有工作流、没有技能、没有联网搜索、没有遥测。模型看到的是 `medical_case_intake`、`medical_case_update`、`medical_case_get` 三个工具，背后是一个把病例存进会话日志的领域包。它记录并报告缺口，不做诊断、不开处方、不做风险评估。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

直接启动该 profile。与所有 headless profile 一样，它回答一个任务后退出。

```sh
dsh --profile medharness "我头疼、发烧两天了，25 岁"
```

Web 界面是同一套运行时叠在 `dsh-web-app` 之上：

```sh
dsh --profile medharness-web
```

那里 Agent 的工具来自它的 preset 而不是宿主机平面，所以 Web 医疗会话看到的是 `dsh-agent-presets` 里的 `medical` preset —— 它挂载同样这三个工具。

两个 profile 都通过 `dsh-session-persistence-jsonl` 把会话持久化到 `$DSH_HOME/sessions` 下，病例就以 `medical/case-change` 事件的形式存在于同一份会话日志里。`dsh plugin --profile medharness` 可管理 profile 本地依赖；profile、home 与有序的 `--patch` 文件仍可覆盖行。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

本 bundle 的单个 insert 是一棵独立树，不是「复制 `dsh-base` 再把行关掉」。减法式组合依然会安装、解析并版本化 base 声明的每一个编码 Agent 包；这里只列出医疗 Agent 需要的东西，方式与 [`dsh-sdk-minimal`](../sdk-minimal/README.zh.md) 一致。

医疗行使用裸包名。这能成立，是因为本 bundle 在 `package.json` 里显式声明了它们每一个，并且 `apps/cli` 依赖本 bundle：安装包的模块回退走查从 `apps/cli/package.json` 出发，把它的依赖闭包镜像到 `$DSH_HOME/profiles/node_modules`；任何 bundle 都不声明的包因此不在这次走查里，每次模型请求都会以 `REQUEST_EXTENSION` 失败。

遥测是「不存在」而不是「被关闭」。`DSH_TELEMETRY_DISABLED` 开关由启动器以 patch 形式施加，`config` 无法禁用一行，而 `patchReload: startup` 的 profile 在启动时就冻结了整棵树 —— 所以从组合里删掉那一行，才是「病例对话永不被导出」这一保证的唯一组合层实现。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 完整的独立 profile 树：运行时脚手架、会话与投影、进程约束、Agent 循环，以及四行医疗组合 |
| [`src/index.ts`](src/index.ts) | Bundle 包入口 |
| — | 不发布运行时不变式伴随模块；本包是静态的 patch 列表载体，其插入的行各自拥有运行时关系与不变式伴随模块。 |
| [`tests/medharness-bundle.spec.ts`](tests/medharness-bundle.spec.ts) | 声明树契约、真实 boot 出来的工具面、token 预算，以及 Web 侧解析的 preset |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [base bundle](../base/README.zh.md) —— 本 profile 刻意省略的完整产品基础。
- [sdk-minimal bundle](../sdk-minimal/README.zh.md) —— 另一个独立 bundle，也是本包效仿的范式。
- [医疗病例领域](../../medical/medical-case/README.zh.md) —— 三个工具读写的那份会话内病例。

-----

<a id="model-experience"></a>
## 模型体验

### 医疗接诊组合

#### 模型看到什么

一段人设，说明该 Agent 记录事实、追问缺失项，且从不诊断、开处方或评估风险。恰有三个工具 schema：`medical_case_intake`、`medical_case_update`、`medical_case_get`。没有仓库指令文件，除人设自带的尾注外没有运行时上下文快照，也没有任何用于读取、写入、执行、搜索、委派或联网的工具。

#### Token 影响

一段稳定的人设加三个工具 schema —— 实测 4,533 字节，约 1,133 tokens；同一 Agent 跑在 `dsh-base` 之上时为 29,612 字节、约 7,403 tokens。会话历史与工具结果随会话增长，与其他 profile 一致。

#### KV Cache 影响

在人设、provider、model 与 bundle patch 栈固定的前提下稳定。工具呈现模式被固定为 `native`，因此环境无法把 schema 换成单个 `run_code`，也就不会让缓存前缀失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **Web profile 是基于 base 的** —— `dsh-web-app` 按 id 覆盖 base 的行并插入整套 client/Host 栈，因此它期望一棵 base 支撑的树。Web 侧的工具面不受影响，因为该 profile 已禁用宿主机平面的编码工具行，并按 preset 决定每个 Agent 的工具。
- **未为普通 `web` profile 提供医疗 preset** —— `medical` preset 假定组合已挂载 `@deepseek-ai/dsh-medical-case`，而这由 `medharness` bundle 提供。请使用 `--profile medharness-web`，不要把该 preset 直接叠到 `web` 上。
- **没有复用 headless runner 的人设行** —— `medharness` profile 把 `dsh-headless` 列在前面，好让本 bundle 的人设成为更后一层。未来若有 mode bundle 覆盖 `system-prompt`，需要保持同样的顺序。

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

`dsh-medharness` 是 MedHarness 运行时组合的唯一权威。早先的 `medharness/cordis.patch.yml` 原型及其测量脚本已在本 bundle 建立后移除，因此不存在第二份会漂移的权威。

</details>
