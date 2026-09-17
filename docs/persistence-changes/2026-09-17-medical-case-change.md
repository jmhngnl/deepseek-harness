---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-medical-case-change

English | [中文](2026-09-17-medical-case-change.zh.md)

## Summary

Adds the `medical/case-change` session event type, carrying the complete post-mutation medical intake case state (case id, revision, symptoms, duration, age, additional notes, and the two timestamps). Each record is a whole value, never a delta, so a projection reading only the latest record already holds the authoritative case.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid and no writer changes behavior: this adds an ordinary event type and changes no existing type, header, or envelope, which the fixed compatibility rules classify as `same-version` — no SessionHeader version increment and no migration are required. The type is included in the generated `KNOWN_SESSION_EVENT_TYPES`, so a build that knows it interprets the record instead of refusing the log. A log written by this build is unreadable by an older build that lacks the type and sees no `ignorable` marker, which is the intended fail-closed behavior for an authoritative domain record; the case history is additive session data, so a session that never records a case is unaffected.

<a id="verification"></a>
## Verification

Added the `SessionEventMap` augmentation in `packages/medical/medical-case/src/domain.ts` and regenerated `packages/core/session/src/known-event-types.ts` with `tsx scripts/gen-persistence-catalog.ts` (one added line, no hand edit). `tsx scripts/persistence-changes.ts --check --json` reports `event:medical/case-change: root added (same-version allowed)` with `requiresVersionBump: false`. `vitest run packages/medical`: 133 tests passed, including a stored-log replay that reads the event back through the JSONL persistence seam and folds the same case. Live end-to-end with a real model: `medical_case_intake` then `medical_case_update` appended revision 1 and revision 2 to one case id, read back by `medical_case_get` on the headless profile and through a two-turn Web UI conversation.

<a id="dev-note"></a>
## Dev Note

None.
