---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-medical-image-observation

English | [中文](2026-09-29-medical-image-observation.zh.md)

## Summary

Adds the `medical/image-observation` session event type, carrying the complete post-mutation observation of one session image (canonical attachment reference, revision, body region, findings, quality verdict with its issues, uncertainty, and two timestamps). Each record is a whole value, never a delta, so a projection reading only the latest record already holds the authoritative observation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid and no writer behavior changes: the type is already declared in `SessionEventMap` and already written by this build, and this adds an ordinary event type while changing no existing type, header, or envelope, which the fixed compatibility rules classify as `same-version` — no SessionHeader version increment and no migration are required. What actually changed is the generated inventory: the type was missing from `KNOWN_SESSION_EVENT_TYPES`, so the read path refused a log this build had itself written with `unknown to this harness and not marked ignorable`. A log that never observes an image has no such record and is unaffected. The type is included in the generated `KNOWN_SESSION_EVENT_TYPES`, so a build that knows it interprets the record instead of refusing the log. A log written by this build stays unreadable by an older build that lacks the type and sees no `ignorable` marker, which is the intended fail-closed behavior for an authoritative domain record: image observations are additive session data, and skipping one would reconstruct a session whose images appear never to have been examined.

<a id="verification"></a>
## Verification

Regenerated with `pnpm run gen-persistence-catalog` (one added line in `packages/core/session/src/known-event-types.ts`, no hand edit; both `medical/case-change` and `medical/image-observation` are present). `pnpm run verify-persistence-catalog` passes and `verify-persistence-changes --check --json` reported `event:medical/image-observation: root added (same-version allowed)` with `requiresVersionBump: false`. Added `packages/medical/medical-image/tests/persistence.spec.ts`: a live session writes an observation through the production writer into a real JSONL log, the context is disposed, and a second context opens the same log through `ctx.sessionPersistence.open`, replays the domain projection, and resumes an agent on it — asserting the canonical attachmentId, revision, body region, findings, quality verdict, and uncertainty survive. The test was confirmed to be a real regression guard by temporarily removing the generated entry: all four cases then fail with `SessionFormatUnsupportedError: ... contains event type "medical/image-observation" (seq 1) unknown to this harness and not marked ignorable`, the exact reported failure, and pass again with it restored. `vitest run packages/medical`: 488 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
