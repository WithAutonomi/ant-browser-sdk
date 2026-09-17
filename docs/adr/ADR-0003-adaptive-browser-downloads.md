# ADR-0003: Adaptive browser downloads through the shared Rust scheduler

- **Status:** Proposed
- **Date:** 2026-09-17
- **Decision owners:** Engineering team
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0002; ant-core shared read engine; 2026-09-17 download audit

## Context

The SDK defaults to three concurrent record fetches and the browser core clamps
requests to six. These fixed settings prevent the native adaptive scheduler from
responding to actual throughput. Browser discovery also shares ordered RPC work
with bulk responses, and previously waited for complete lookup rounds before
trying newly discovered holders.

## Decision Drivers

- Improve downloads across devices without selecting settings for one host.
- Retain shared native/browser integrity, retry, and absence policies.
- Bound speculative traffic and transient response memory.
- Preserve explicit application ceilings and cancellation cleanup.

## Considered Options

1. Increase the fixed browser concurrency constant.
2. Choose concurrency from processor count or a benchmark-machine profile.
3. Use the shared throughput scheduler with browser resource admission.

## Decision

We propose option 3. Omitted download concurrency and `"auto"` select the shared
Rust adaptive scheduler. Explicit integers from 1 through 256 remain logical
record-fetch ceilings; they do not force that many requests. The scheduler starts
at four and learns from verified useful bytes and completed operation timing.
Native and browser use the same shorter, evidence-bounded observation epochs.

The browser separately admits physical GETs, including speculative requests,
against a 128 MiB reservation budget for worst-case encrypted, plaintext, and
decoded responses. Response CPU time and event-loop lateness reduce local
admission when processing exceeds a 50 ms responsiveness target, with gradual
recovery after healthy responses. This is not a complete-file memory bound.

The shared read engine can fetch candidates before discovery completes. Content
and peer authentication remain mandatory; early misses never establish absence.
Browser control and bulk RPCs use two authenticated DataChannels on one WebRTC
association, avoiding the per-channel RPC queue without duplicating ICE setup.
Current nodes must allow two channels per association, their default setting.
There is no fallback for custom nodes configured to allow only one channel.

## Consequences

### Positive

- Ordinary SDK downloads can adapt without application tuning.
- Slow local processing can reduce physical admission below the network floor.
- Control work progresses independently of bulk RPCs.

### Negative / Trade-offs

- More useful concurrency can increase instantaneous bandwidth and memory use.
- The default and `SDK_LIMITS.downloadConcurrency.default` change from numeric
  three to `"auto"`; callers consuming the constant must handle its new type.
- Whole-file reconstruction and SDK byte/Blob copies still scale with file size.
- Two channels add a second authenticated session and require compatible nodes.

### Neutral / Operational

- No wire format, payment policy, or persisted storage format changes.
- Existing numeric settings 1–6 remain valid ceilings. No new dependencies.
- ADR-0002's explicit network identity and trust-anchor rules remain unchanged.
- Rebuild bindings, WASM, and source provenance together from clean Rust sources.

## Validation

Run shared native and browser tests, SDK checks, all example builds, package
inspection, and governance checks. Test bounded admission, cancellation, corrupt
content, slow processing, lane independence, and stale adaptive observations.
Repeat fresh-client downloads of the same public file on the same testnet using
native and browser clients, verifying byte count and an independent digest.
Include a CPU-throttled browser scenario; do not generalize one host to all devices.
Record revisions, exact results, and limitations in
[the dated audit](../audits/2026-09-17-adaptive-downloads.md).

## Notes for AI-assisted work

This ADR remains Proposed pending human engineering review. Accepted ADRs are
immutable; later changes require a superseding record.
