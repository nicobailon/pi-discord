<p>
  <img src="banner.png" alt="pi-discord" width="1100">
</p>

# pi-discord

A Discord bot that brings Pi into your server. Mention the bot or use slash commands to run Pi with full tool access, persistent sessions, and optional project extensions.

**How it works:** A detached daemon listens for Discord mentions, DMs, and slash commands. Each channel gets its own persistent Pi session, so follow-up questions remember earlier conversation. When a message comes in, the daemon calls `session.prompt()`, subscribes to the response stream, and live-updates the Discord reply as text streams back. Operator runs `/discord start|stop|status` from Pi to control it.

Requires a bot token and application id from the Discord Developer Portal.

```text
/discord setup
/discord start

# In Discord
/pi ask text:"Summarize the errors in the latest deploy"
@your-bot check the logs and tell me what failed
```

<img src="discord-chat.png" alt="Discord chat example" width="500">

## What it does

- `/discord` commands in Pi for setup, start, stop, status, logs, config
- detached daemon that stays connected to Discord independently of Pi
- durable per-route state: registry, queue, journal, sessions, memory
- routing scoped to channel or thread by Discord ids
- headless Pi sessions via `createAgentSession()`
- slash commands and @mention ingress
- `discord_upload` tool for posting files back to Discord
- throttled message updates with details-thread fallback
- DM allowlisting and admin controls for stop/reset

## Install

```bash
pi install npm:pi-discord
```

Then restart Pi so it discovers the extension.

## Quick start

Inside Pi:

```text
/discord setup
/discord start
/discord status
```

That writes the runtime config, optionally syncs Discord slash commands, and launches the detached daemon.

Once the bot is in your server, you can talk to it with either:

```text
/pi ask text:"Check the repo status and summarize"
```

or a direct mention:

```text
@your-bot inspect the latest error screenshot
```

To stop the helper process:

```text
/discord stop
```

To inspect logs:

```text
/discord logs 120
```

## Setting up the Discord app correctly

This is the part that usually goes wrong. Here's a quick checklist, followed by detailed steps.

### Quick checklist

1. **Developer Portal** → Create Application
2. **General Information** → Copy `Application ID`
3. **Bot** → Create Bot → Copy `Token`
4. **Bot** → Enable `Message Content Intent` ✓
5. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files, Embed Links
6. **Copy invite URL** → Add bot to your server
7. **Discord Settings** → Enable Developer Mode → Right-click server → Copy Server ID

### Detailed steps

Go to the Discord Developer Portal at `https://discord.com/developers/applications` and create a new application. Give it a name that matches the bot you want to run.

Open the application's `General Information` page. Copy the `Application ID`. You will put that into the `applicationId` field in the `pi-discord` config. You can ignore the `Public Key` for now because this package currently talks to Discord through the gateway rather than receiving webhook interactions directly.

Open the `Bot` page and create a bot user if Discord has not done that already. Reset the token if needed, then copy the bot token. Put that into `botToken`.

Still on the `Bot` page, decide whether you need the `Message Content Intent`.

You should enable `Message Content Intent` if you want any of the following:

- mention-triggered prompts that rely on full message content
- ambient recent-channel context in normal guild channels
- attachment ingestion from ordinary message events
- a more natural “talk to the bot in chat” flow rather than slash-command-only usage

If your bot is or becomes a verified bot in 100+ servers, Discord may require privileged-intent approval for full behavior in ordinary guild traffic. Without that approval, the safest expectation is degraded mode built around slash commands, DMs, and direct mentions.

Go to `OAuth2` → `URL Generator`.

Select these scopes:

- `bot`
- `applications.commands`

Select permissions that let the bot operate in channels and threads. At minimum you will usually want:

- `View Channels`
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Read Message History`
- `Attach Files`
- `Embed Links`

If you want private-thread behavior in a locked-down server, add the thread permissions your server policy requires. Keep permissions minimal; the bot does not need broad moderation powers.

Use the generated invite URL to add the bot to your server.

After the bot is in the server, collect the guild ids you want to allow. In Discord, enable Developer Mode in advanced settings, then right-click the server and copy the server id. Add those to `allowedGuildIds` if you want an explicit allowlist.

## Pi-side setup flow

The easiest path is:

```text
/discord setup
```

That prompts for the bot token, application id, and a comma-separated guild allowlist, then writes the JSON config file at:

`~/.pi/agent/pi-discord/config.json`

You can also edit the config directly with:

```text
/discord open-config
```

Or re-sync slash commands manually with:

```text
/discord sync-commands
```

## Config reference

The runtime config lives at:

`~/.pi/agent/pi-discord/config.json`

Current fields:

- `botToken`: Discord bot token from the Bot page
- `applicationId`: Discord application id from General Information
- `allowedGuildIds`: optional guild allowlist. Empty means any guild the bot joins is accepted
- `adminUserIds`: Discord user ids allowed to stop active runs and reset routes
- `dmAllowlistUserIds`: Discord user ids allowed to use the bot in DMs
- `commandName`: slash-command root. Defaults to `pi`, which creates `/pi ask`, `/pi status`, `/pi stop`, and `/pi reset`
- `registerCommandsGlobally`: if `true`, registers commands globally instead of guild-scoped
- `syncCommandsOnStart`: if `true`, `/discord start` syncs slash commands before starting the daemon
- `workspaceMode`: `dedicated` or `shared`
- `sharedExecutionRoot`: execution root to use when `workspaceMode` is `shared`
- `routeOverrides`: per-route overrides for execution root or workspace mode
- `allowProjectExtensions`: if `true`, bot sessions load discovered extensions in addition to the built-in helper extension. This is less safe in headless mode
- `enableImageInput`: if `false`, image attachments stay on disk and are described in text instead of being sent as model image input
- `enableDetailsThreads`: if `true`, the daemon will try to open and reuse a details thread for tool chatter and uploads
- `globalConcurrency`: max routes processed at once
- `queueLeaseMs`: queue lease duration before abandoned work is recovered
- `primaryFlushMs`: cadence for throttled primary-message edits while the assistant is streaming
- `defaultModel`: optional `provider/model-id` for new routes
- `defaultThinkingLevel`: Pi thinking level for new routes

## Discord commands and triggers

Inside Discord, the package currently supports these slash subcommands under whatever `commandName` is configured:

- `/pi ask text:"..."`
- `/pi status`
- `/pi stop`
- `/pi reset`

In addition, a direct mention in a guild channel or a DM from an allowlisted user will enqueue work for the current route.

Once a route already exists, ordinary non-mention guild messages in that same surface are journaled as ambient context instead of immediately triggering the agent.

## Pi operator commands

Inside Pi, the extension exposes:

- `/discord setup`
- `/discord open-config`
- `/discord sync-commands`
- `/discord start`
- `/discord stop`
- `/discord status`
- `/discord logs [lines]`
- `/discord help`

## Runtime layout

The package code stays in the extension directory. Mutable runtime state lives separately under:

`~/.pi/agent/pi-discord`

That workspace contains:

- `config.json`
- `logs/daemon.log`
- `run/status.json`
- `run/daemon.pid` and lock state
- `routes/` with per-route manifests, journals, attachments, queue state, and route session files
- `workspaces/` with dedicated execution roots for dedicated-mode routes

This separation is intentional. Runtime state should not be mixed into the extension package itself.

## How routing works

A route is keyed by Discord identity, not by an arbitrary chat title. The route key is built from:

- guild id or `dm`
- channel id
- optional thread id

Each route owns:

- a route manifest
- a durable queue
- an append-only transport journal
- a route memory file
- a session storage directory
- inbound and outbound attachment folders
- an execution root

By default, each route gets a persistent Pi session. The route manifest keeps the stable mapping between the route key and the current session file, plus message/thread ids used for outbound rendering.

## Session behavior

Bot sessions are created with the Pi SDK, not with a separate custom context store. The daemon uses `createAgentSession()` and binds a small helper extension so it can:

- inject route memory and bounded recent Discord context at request time
- expose a `discord_upload` tool for explicit file egress back into Discord
- keep the session headless-safe by avoiding interactive UI assumptions

Raw Discord text is sent through `session.prompt(..., { expandPromptTemplates: false, source: "extension" })` so normal Discord content beginning with `/` stays literal unless it came from an explicit Discord slash command.

## Attachments and images

Inbound attachments are downloaded into the route workspace before the run starts.

If an attachment is an image and the selected model supports image input, the daemon passes it through as Pi image content. Otherwise the saved file path is still included in the prompt context so the model can reason about the file as a normal artifact.

For outbound files, the bot session can use the `discord_upload` tool to post a generated file back into the current Discord surface or details thread.

## Observability and logs

The daemon writes structured JSON log lines to:

`~/.pi/agent/pi-discord/logs/daemon.log`

The current extension surfaces those logs with:

```text
/discord logs 200
```

Daemon health is summarized in:

```text
/discord status
```

which reports whether the daemon is running, its pid, known route count, and currently active runs.

## Implementation details

**Queueing**: Each route has a durable queue that survives daemon restarts. Work items are leased with expiration timestamps, so if the daemon crashes mid-run, abandoned work is automatically recovered and retried on the next startup.

**Journaling**: An append-only journal records all inbound messages, edits, deletions, and assistant responses for each route. This provides bounded recent context for new prompts and supports post-hoc debugging without relying on Discord message history.

**Route registry**: A central registry tracks known routes by their Discord identity (guild/channel/thread). Each route maintains its own manifest with pointers to the current session file, primary message id, and details thread id.

**Restart recovery**: On startup, the daemon iterates known routes, recovers any expired queue leases, and backfills recent channel messages into the journal as ambient context. This means the bot can pick up where it left off even after an unexpected exit.

**Detached daemon**: The Discord gateway connection runs in a separate long-lived process (`pi-discord-daemon`) rather than inside Pi's runtime. This lets the bot stay online independently of any interactive Pi session.

## Safety model

A few constraints are deliberate.

DMs are deny-by-default and only open to ids listed in `dmAllowlistUserIds`.

Stop and reset controls are restricted to ids listed in `adminUserIds`.

Project extensions are off by default in bot sessions because many extensions assume an interactive TUI and human supervision.

The package stores route state separately from the extension package so updates or reinstalls do not trample mutable bot data.

## Limitations

No `launchd` or systemd service generation yet. No UI for editing route overrides. No full setup wizard beyond `/discord setup`. Some config fields exist for architectural reasons but aren't fully exercised. Gateway-only for now, no webhook ingestion.

## Troubleshooting

If `/discord start` fails immediately, run:

```text
/discord status
/discord logs 200
```

If slash commands do not appear, check these in order:

- `applicationId` is correct
- the bot token belongs to the same application
- the bot was invited with `applications.commands`
- the bot is in one of the `allowedGuildIds`, or `registerCommandsGlobally` is enabled
- command sync did not fail during `/discord start`

If mentions do nothing, check:

- the bot can read the channel
- `Message Content Intent` is enabled where needed
- the daemon is running
- the guild is allowlisted if you are using `allowedGuildIds`

If DMs do nothing, check that the sender id is listed in `dmAllowlistUserIds`.

If stop buttons or the `/pi reset` command refuse to work, check that the requester id is in `adminUserIds`.

## Development

Install dependencies and run the test suite:

```bash
npm install
npm test
```

The current test coverage focuses on config validation and recovery paths, route identity and initialization, queue/registry/manifest persistence hardening, interaction scoping, daemon status handling, and core authorization behavior.
