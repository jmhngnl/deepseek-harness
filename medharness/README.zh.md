# MedHarness

[English](README.md) | 中文

MedHarness 是构建在 DeepSeek Harness 上的医疗接诊 Agent。本目录保存本 fork 的**审计记录**；运行时组合本身已经是一个 Harness 一等公民 bundle。

**唯一权威：[`packages/bundle/medharness`](../packages/bundle/medharness/README.zh.md)。**

早先的原型曾以 `--patch` 覆盖层加一个测量脚本的形式放在这里。两者都已移除：bundle 建成后它们就成了第二份可能漂移的权威，而 bundle 的 `tests/medharness-bundle.spec.ts` 断言的正是脚本当年只是打印出来的东西。请使用 profile，而不是覆盖层：

```sh
dsh --profile medharness "我头疼、发烧两天了，25 岁"
dsh --profile medharness-web
```

## 审计测到了什么

改前改后的运行时工具面，取证自真实会话的持久 `request/header` 事件 —— 那是唯一能观察到「模型实际看到什么」的地方：

| | `request/header.tools` 中的工具数 | tool schema 大小 |
|---|---|---|
| 跑在 `dsh-base` 之上（27 个工具，其中 24 个是编码工具） | **27** | 29,612 字节 ≈ **7,403 tokens** |
| `medharness` | **3** | 4,533 字节 ≈ **1,133 tokens** |

三个工具是 `medical_case_intake`、`medical_case_update`、`medical_case_get` —— 工具数下降 89%，每次请求省下约 6,300 tokens，这还没算被移除插件原本贡献的系统提示段落。

## 审计决定了什么

**被别的行注入的行不是工具面。** `bash-sandbox` / `pwsh-sandbox` 是抽象 `shell` 服务的实现，而该服务由 `permission-presets` 注入；`shell-env` 发布的是 `apps/cli/src/web.ts` 注入的 shell 环境注册表。移除它们损失的是依赖它们的服务，不是攻击面；三者都不注册工具。正因为这条判据，独立组合保留了进程约束与文件系统 provider，却不声明任何 shell 或文件系统工具。

**遥测无法从配置层面关闭。** `config` 不能禁用一行，启动器把环境开关当作 patch 施加，而 `patchReload: startup` 的 profile 在启动时就冻结整棵树。另需记录的是：出厂默认 `FEEDBACK_ONLY` 只在显式反馈事件（`feedback/record`、`feedback/message-put`、`feedback/message-delete`）之后才导出会话日志前缀，普通对话并不被采集。但对临床文本而言，整行不挂载仍是更强的保证 —— bundle 就是这么做的。

**`REQUEST_EXTENSION` 究竟为什么发生。** 模块回退表镜像的是安装锚点 `apps/cli/package.json` 的依赖闭包（`packages/boot/app-boot/src/profile.ts` 的 `resolveModuleFallbackEntries`）。该锚点依赖每一个 bundle，却不依赖任何 medical 包，于是走查永远到不了它们，`plugin-package-inventory-deepseek` 的 `barePackageManifest` 也就解析不到任何东西。把本 bundle 声明进 `apps/cli` 正是补上这个缺口 —— 这也是本 bundle 的行使用裸包名而非相对源码路径的原因。

## 尚未做，且是刻意为之

若干大型子系统**不被任何 bundle 挂载** —— SSH、browser-use、computer-use、desktop、`experimental/`、`benchmarks`、`website`、`native/system` —— 因此它们在运行时零成本，删除它们是仓库体积问题而非攻击面问题。那是另一个决定，有自己的构建系统影响面：`native/system` 被 `pnpm-workspace.yaml` 显式枚举并在 `tsconfig.base.json` 里有映射，`experimental/` 被 `scripts/gen-tool-catalog.ts` 直接 import，`website/` 位于 host tsconfig 中。本次**没有删除任何东西**。
