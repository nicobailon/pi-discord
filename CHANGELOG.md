# Changelog

## [Unreleased]

## [0.2.0] - 2026-03-23

Post-complete message delivery and trigger file polling for companion/proactive bots.

- **Post-complete mode**: accumulate assistant response text silently, then post a single clean message instead of streaming edits. Avoids the permanent "(edited)" tag on every bot reply.
- **Trigger file polling**: new `processTriggers()` method polls a `triggers/` directory every 30 seconds. Extensions can write JSON trigger files to enqueue proactive messages without touching the Discord API directly.
- **Trigger source kind**: queue now accepts `"trigger"` as a valid source kind alongside `"message"` and `"interaction"`.
- **Error feedback**: on LLM failure, post a brief error message to the channel instead of silently failing. Trigger failures are suppressed (no channel to post to).
- **Journal differentiation**: trigger responses are journaled as `trigger-sent` or `trigger-suppressed` (for `[NO_OUTREACH]`) instead of `assistant-final`.

## [0.1.1] - 2026-03-13

Documentation and cleanup.

- Added "How it works" paragraph to README explaining the message flow
- Removed redundant "Why" section from README
- Removed unnecessary `mkdir` import and call in runtime.js
- Consolidated renderer tests to use flat `test()` style
- Made package public for npm publishing

## [0.1.0] - 2026-03-12

Initial release.

- Discord bot daemon with gateway connection
- Mention and DM ingress to headless pi sessions
- Slash commands (`/pi ask`, `/pi status`, `/pi stop`, `/pi reset`)
- Per-route queue with lease-based work distribution
- Route registry with dedicated/shared workspace modes
- Journal for ambient context and edit/delete tracking
- `discord_upload` tool for bot sessions
- Pi operator commands (`/discord start`, `stop`, `status`, `logs`, etc.)
