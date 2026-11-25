# Changelog

## 0.4.0

- Add configurable handoff ownership checks, optional worktree isolation, and optional run recovery and stall detection.
- Add cross-platform relay transport and Unix resume plans, with platform-specific runtime verification still required.
- Add run metrics, replay, offline export, and a client adapter interface.
- Add CI, a license, and updated setup and threat-model documentation.

Ownership checks in a shared checkout cannot attribute changes to individual workers. Experimental Gemini configuration remains disabled until the relay supports it. Explicit heartbeats are required when stall detection is enabled.
