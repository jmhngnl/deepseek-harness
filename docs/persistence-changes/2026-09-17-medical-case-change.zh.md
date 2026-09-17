---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-17-medical-case-change

[English](2026-09-17-medical-case-change.md) | 中文

## 概述

新增 `medical/case-change` 会话事件类型，携带变更后的完整医疗接诊病例状态（病例 id、修订号、症状、持续时间、年龄、补充说明与两个时间戳）。每条记录都是完整值而非增量，因此只读最近一条的投影就已经持有权威病例。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-medical-case-change
baseline: false
changes:
  - root: "event:medical/case-change"
    previous: null
    after: "cc1bde316381efe4554dc83dcce118451d9b74c254575f59c44199db9c22e425"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，写入方行为不变：这是新增普通事件类型，未改动任何已有类型、头部或事件封装，按固定兼容性规则属于 `same-version`——不需要 SessionHeader 版本递增，也不需要迁移。该类型会进入生成的 `KNOWN_SESSION_EVENT_TYPES`，因此认识它的构建会解释该记录而不是拒绝整个日志。由本构建写出的日志，在其缺少该类型且没有 `ignorable` 标记的旧构建上无法读取，这是权威领域记录应有的失败关闭行为；病例历史是追加式会话数据，从未记录病例的会话不受影响。

<a id="verification"></a>
## 验证

在 `packages/medical/medical-case/src/domain.ts` 中加入 `SessionEventMap` 合并声明，并用 `tsx scripts/gen-persistence-catalog.ts` 重新生成 `packages/core/session/src/known-event-types.ts`（新增一行，无人工编辑）。`tsx scripts/persistence-changes.ts --check --json` 报告 `event:medical/case-change: root added (same-version allowed)`，`requiresVersionBump: false`。`vitest run packages/medical`：133 个测试通过，其中包括一次存储日志重放——通过 JSONL 持久化 seam 读回该事件并折叠出同一份病例。真实模型端到端：`medical_case_intake` 与 `medical_case_update` 为同一病例 id 追加修订号 1 和 2，并由 `medical_case_get` 读回，在 headless profile 与 Web UI 的两轮对话中均已验证。

<a id="dev-note"></a>
## 开发备注

无。
