---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-medical-image-observation

[English](2026-09-29-medical-image-observation.md) | 中文

## 概述

新增 `medical/image-observation` 会话事件类型，携带某张会话图像变更后的完整观察（canonical 附件引用、修订号、部位、发现、质量判定及其问题列表、不确定项，以及两个时间戳）。每条记录都是完整值而非增量，因此只读最近一条的投影就已经持有权威观察。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-medical-image-observation
baseline: false
changes:
  - root: "event:medical/image-observation"
    previous: null
    after: "a8318eb9a0a93699fc056e1a4646d05e65739e21228b9e6436d849c74f581f4f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，写入方行为不变：该类型本就已在 `SessionEventMap` 中声明、且本构建本就已在写它；这次是新增普通事件类型，未改动任何已有类型、头部或事件封装，按固定兼容性规则属于 `same-version`——不需要 SessionHeader 版本递增，也不需要迁移。真正变化的是生成清单：该类型此前缺失于 `KNOWN_SESSION_EVENT_TYPES`，导致读取路径会以 `unknown to this harness and not marked ignorable` 拒绝本构建自己写出的日志。从未观察过图像的会话不含该记录，不受影响。该类型会进入生成的 `KNOWN_SESSION_EVENT_TYPES`，因此认识它的构建会解释该记录而不是拒绝整个日志。由本构建写出的日志，在其缺少该类型且没有 `ignorable` 标记的旧构建上仍然无法读取，这是权威领域记录应有的失败关闭行为：图像观察是追加式会话数据，跳过一条会重建出一个「图像从未被查看过」的会话。

<a id="verification"></a>
## 验证

用 `pnpm run gen-persistence-catalog` 重新生成（`packages/core/session/src/known-event-types.ts` 新增一行，无人工编辑；`medical/case-change` 与 `medical/image-observation` 均在）。`pnpm run verify-persistence-catalog` 通过，`verify-persistence-changes --check --json` 报告 `event:medical/image-observation: root added (same-version allowed)`，`requiresVersionBump: false`。新增 `packages/medical/medical-image/tests/persistence.spec.ts`：真实会话经生产写入器把一次观察写进真正的 JSONL 日志，dispose 上下文后，第二个上下文用 `ctx.sessionPersistence.open` 打开同一份日志、重放领域投影并在其上 resume 一个 agent——断言 canonical attachmentId、修订号、部位、发现、质量判定与不确定项都能存活。该测试被确认是真正的回归护栏：临时移除生成表中的那一行后，四个用例全部以 `SessionFormatUnsupportedError: ... contains event type "medical/image-observation" (seq 1) unknown to this harness and not marked ignorable`（即所报告的原错误）失败，恢复后重新通过。`vitest run packages/medical`：488 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
