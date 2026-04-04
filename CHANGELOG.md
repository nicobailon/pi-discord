# Changelog

## [Unreleased]

## [0.2.5] - 2026-04-04

- Compatibility update for pi `0.65.x`: migrate session host model registry initialization to `await ModelRegistry.create(...)` and bump `@mariozechner/pi-coding-agent` to `^0.65.0`.

## [0.2.4] - 2026-03-24

- **Display names**: use `displayName` instead of `username` in Requester lines and journal entries. The agent now sees "nicopreme" instead of "cartjacked." — matching what Discord shows in the UI. Falls back through server nickname → global display name → username.

## [0.2.3] - 2026-03-23

- **Emoji reactions**: ingest user reactions into recent Discord context and add a `discord_react` tool so the bot can react to the source message.

## [0.2.2] - 2026-03-24

- **Conversation followups**: non-mention messages are now enqueued when they continue an active conversation. Two signals: reply to a bot message (cache check, no API call), or same user within 2 minutes of the bot's last response. Other messages remain ambient-only.

## [0.2.1] - 2026-03-23

- Bump `@mariozechner/pi-coding-agent` dependency from `^0.57.1` to `^0.62.0`

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
