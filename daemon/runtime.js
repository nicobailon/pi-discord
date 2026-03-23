import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { authorizeInteraction } from "./authz.js";
import { JournalStore } from "./journal.js";
import { Logger } from "./logger.js";
import { buildPromptText } from "./prompt-shaper.js";
import { RouteQueueStore } from "./queue-store.js";
import { DiscordRenderer, splitDiscordText } from "./renderer.js";
import { RouteRegistry, createRouteManifest } from "./registry.js";
import { makeRouteKey } from "./route-key.js";
import { RouteSessionHost } from "./session-host.js";
import { ensureDir, pathExists, removeIfExists, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";

function stripBotMention(content, botId) {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}

async function toImageContent(filePath, mediaType) {
  const data = await readFile(filePath);
  return {
    type: "image",
    source: {
      type: "base64",
      mediaType,
      data: data.toString("base64"),
    },
  };
}

export class PiDiscordDaemon {
  /**
   * @param {{
   *   paths: ReturnType<import('../lib/paths.js').getPaths>,
   *   config: import('../lib/config.js').PiDiscordConfig,
   * }} options
   */
  constructor(options) {
    this.paths = options.paths;
    this.config = options.config;
    this.logger = new Logger(this.paths.daemonLogPath);
    this.registry = new RouteRegistry(this.paths);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.routeContexts = new Map();
    this.routePromises = new Map();
    this.currentRuns = new Map();
    this.workerId = `daemon-${process.pid}`;
    this.heartbeat = undefined;
    this.triggerInterval = undefined;
    this.stopping = false;
    this.status = {};
  }

  runInBackground(label, task, details = {}) {
    void Promise.resolve()
      .then(task)
      .catch(async (error) => {
        await this.logger.error(label, { ...details, error: String(error) });
      });
  }

  async start() {
    await ensureDir(this.paths.workspaceDir);
    await ensureDir(this.paths.runDir);
    await ensureDir(this.paths.logsDir);
    await this.registry.load();
    this.attachEventHandlers();
    await this.writeStatus({ phase: "starting" });
    await this.client.login(this.config.botToken);
    this.heartbeat = setInterval(() => {
      this.runInBackground("status-write-failed", async () => {
        await this.writeStatus({ phase: "running" });
      });
    }, 15_000);
    this.triggerInterval = setInterval(() => {
      this.processTriggers().catch((err) =>
        this.logger.error("trigger-poll-failed", { error: String(err) }),
      );
    }, 30_000);
  }

  async processTriggers() {
    const triggersDir = path.join(this.paths.workspaceDir, "triggers");
    if (!existsSync(triggersDir)) return;
    const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const triggerPath = path.join(triggersDir, file);
      try {
        const trigger = JSON.parse(readFileSync(triggerPath, "utf8"));
        unlinkSync(triggerPath);
        const scope = this.resolveScope(trigger.guildId ?? null, trigger.channelId, null);
        const route = await this.ensureRoute(scope);
        await route.queue.enqueue({
          source: {
            kind: "trigger",
            sourceId: file,
            userId: "",
            guildId: trigger.guildId ?? null,
            channelId: trigger.channelId,
            threadId: null,
            trigger: "proactive",
          },
          payload: {
            rawText: "",
            promptText: trigger.prompt,
            attachments: [],
          },
        });
        await this.scheduleWork();
      } catch (err) {
        this.logger.error("trigger-process-failed", { file, error: String(err) });
        try { unlinkSync(triggerPath); } catch {}
      }
    }
  }

  attachEventHandlers() {
    this.client.once(Events.ClientReady, async (client) => {
      await this.logger.info("discord-ready", { userId: client.user.id, tag: client.user.tag });
      await this.writeStatus({ phase: "ready", userTag: client.user.tag });
      await this.reconcileKnownRoutes();
      await this.scheduleWork();
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        await this.handleMessageCreate(message);
      } catch (error) {
        await this.logger.error("message-create-failed", { error: String(error) });
      }
    });

    this.client.on(Events.MessageUpdate, async (_previousMessage, nextMessage) => {
      let message = nextMessage;
      try {
        if (!message?.id || !message.channelId) return;
        if (message.partial) {
          try {
            message = await message.fetch();
          } catch {
            return;
          }
        }
        if (message.author?.bot) return;
        if (message.guildId && this.config.allowedGuildIds.length > 0 && !this.config.allowedGuildIds.includes(message.guildId)) {
          return;
        }
        if (!authorizeInteraction(message, this.config).allowed) return;

        const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel);
        const route = await this.getExistingRoute(scope);
        if (!route) return;
        if (!route.journal.hasSource(message.id) && !route.queue.hasSource(message.id)) {
          return;
        }

        await route.journal.append({
          kind: "edit",
          sourceId: message.id,
          timestamp: Date.now(),
          routeKey: route.manifest.routeKey,
          text: message.content ?? "",
          authorId: message.author?.id,
          authorName: message.author?.username,
        });
        const replyContext = message.reference?.messageId ? await this.fetchReplyContext(message) : undefined;
        await route.queue.replaceQueuedBySource(message.id, (item) => {
          const rawText = item.source.trigger === "mention" && this.client.user
            ? stripBotMention(message.content ?? item.payload.rawText, this.client.user.id)
            : (message.content ?? item.payload.rawText);
          item.payload.rawText = rawText;
          item.payload.promptText = buildPromptText({
            routeKey: route.manifest.routeKey,
            scope: route.manifest.scope,
            requester: { id: item.source.userId, name: message.author?.username ?? item.source.userId },
            trigger: item.source.trigger,
            rawText,
            replyContext,
            savedAttachments: item.payload.attachments ?? [],
          });
        });
      } catch (error) {
        await this.logger.error("message-update-failed", { error: String(error) });
      }
    });

    this.client.on(Events.MessageDelete, async (message) => {
      try {
        if (!message.id || !message.channelId) return;
        if (message.guildId && this.config.allowedGuildIds.length > 0 && !this.config.allowedGuildIds.includes(message.guildId)) {
          return;
        }
        const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel);
        const route = await this.getExistingRoute(scope);
        if (!route) return;
        if (!route.journal.hasSource(message.id) && !route.queue.hasSource(message.id)) {
          return;
        }
        await route.journal.append({
          kind: "delete",
          sourceId: message.id,
          timestamp: Date.now(),
          routeKey: route.manifest.routeKey,
        });
        await route.queue.cancelQueuedBySource(message.id, "Source message was deleted before execution.");
      } catch (error) {
        await this.logger.error("message-delete-failed", { error: String(error) });
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
        await this.handleInteraction(interaction);
      } catch (error) {
        await this.logger.error("interaction-failed", { error: String(error) });
        if (interaction.isRepliable()) {
          const responder = interaction.deferred || interaction.replied ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
          await responder({ content: String(error), ephemeral: true }).catch(() => undefined);
        }
      }
    });
  }

  resolveScope(guildId, channelId, threadId) {
    return {
      guildId,
      channelId,
      threadId,
      routeKey: makeRouteKey({ guildId, channelId, threadId }),
    };
  }

  resolveScopeFromChannel(guildId, channelId, channel) {
    const isThread = channel?.isThread?.() ?? false;
    return this.resolveScope(
      guildId,
      isThread ? (channel.parentId ?? channelId) : channelId,
      isThread ? channel.id : null,
    );
  }

  async getExistingRoute(scope) {
    if (this.routeContexts.has(scope.routeKey)) {
      return this.routeContexts.get(scope.routeKey);
    }
    if (!(await this.registry.loadManifest(scope.routeKey))) {
      return undefined;
    }
    return this.ensureRoute(scope);
  }

  async ensureRoute(scope) {
    if (this.routeContexts.has(scope.routeKey)) {
      return this.routeContexts.get(scope.routeKey);
    }
    if (!this.routePromises.has(scope.routeKey)) {
      const routePromise = this.createRouteContext(scope)
        .finally(() => {
          if (this.routePromises.get(scope.routeKey) === routePromise) {
            this.routePromises.delete(scope.routeKey);
          }
        });
      this.routePromises.set(scope.routeKey, routePromise);
    }
    return this.routePromises.get(scope.routeKey);
  }

  async createRouteContext(scope) {
    if (this.routeContexts.has(scope.routeKey)) {
      return this.routeContexts.get(scope.routeKey);
    }

    const routePaths = getRoutePaths(this.paths, scope.routeKey);
    let manifest = await this.registry.loadManifest(scope.routeKey);
    if (!manifest) {
      const override = this.config.routeOverrides[scope.routeKey] ?? {};
      const workspaceMode = override.mode ?? this.config.workspaceMode;
      const executionRoot = workspaceMode === "shared"
        ? (override.executionRoot ?? this.config.sharedExecutionRoot)
        : routePaths.dedicatedExecutionRoot;
      if (!executionRoot) throw new Error(`No execution root configured for ${scope.routeKey}`);
      const memoryPath = workspaceMode === "dedicated"
        ? path.join(executionRoot, "discord-memory.md")
        : routePaths.sharedMemoryPath;
      manifest = createRouteManifest({
        routeKey: scope.routeKey,
        scope: { guildId: scope.guildId, channelId: scope.channelId, threadId: scope.threadId },
        workspaceMode,
        executionRoot,
        memoryPath,
      });
      await ensureDir(executionRoot);
      await ensureDir(path.dirname(memoryPath));
      if (!(await pathExists(memoryPath))) {
        await writeFile(memoryPath, "", "utf8");
      }
      await this.registry.saveManifest(manifest);
    }

    await ensureDir(manifest.executionRoot);
    await ensureDir(path.dirname(manifest.memoryPath));
    if (!(await pathExists(manifest.memoryPath))) {
      await writeFile(manifest.memoryPath, "", "utf8");
    }
    await ensureDir(routePaths.routeDir);
    await ensureDir(routePaths.sessionsDir);
    await ensureDir(routePaths.inboundAttachmentsDir);

    const queue = new RouteQueueStore(routePaths.queuePath, this.config.queueLeaseMs);
    await queue.load();
    await queue.recoverExpiredLeases();
    const journal = new JournalStore(routePaths.journalPath);
    await journal.load();
    const renderer = new DiscordRenderer({
      client: this.client,
      manifest,
      logger: this.logger,
      persistManifest: async () => {
        await this.registry.saveManifest(manifest);
      },
      flushMs: this.config.primaryFlushMs,
      enableDetailsThreads: this.config.enableDetailsThreads,
    });
    const host = new RouteSessionHost({
      agentDir: this.paths.agentDir,
      config: this.config,
      manifest,
      routePaths,
      journal,
      logger: this.logger,
      uploadFile: (filePath, options) => renderer.uploadFile(filePath, options),
    });

    const context = { manifest, routePaths, queue, journal, renderer, host };
    this.routeContexts.set(scope.routeKey, context);
    this.runInBackground("status-write-failed", async () => {
      await this.writeStatus();
    });
    return context;
  }

  async handleMessageCreate(message) {
    if (!this.client.user || message.author?.bot) return;
    const authorization = authorizeInteraction(message, this.config);
    if (!authorization.allowed) return;

    const botMentioned = message.mentions.users.has(this.client.user.id);
    const isDm = !message.guildId;
    if (!botMentioned && !isDm) {
      const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel);
      const route = await this.getExistingRoute(scope);
      if (!route) return;
      await route.journal.append({
        kind: "ambient",
        sourceId: message.id,
        routeKey: route.manifest.routeKey,
        timestamp: Date.now(),
        text: message.content ?? "",
        authorId: message.author.id,
        authorName: message.author.username,
      });
      return;
    }

    const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel);
    const route = await this.ensureRoute(scope);
    if (route.journal.hasSource(message.id) || route.queue.hasSource(message.id)) return;

    const savedAttachments = await this.saveInboundAttachments(route, message.attachments.values(), message.id);
    const replyContext = message.reference?.messageId ? await this.fetchReplyContext(message) : undefined;
    const rawText = botMentioned ? stripBotMention(message.content ?? "", this.client.user.id) : (message.content ?? "");
    const promptText = buildPromptText({
      routeKey: route.manifest.routeKey,
      scope: route.manifest.scope,
      requester: { id: message.author.id, name: message.author.username },
      trigger: isDm ? "dm" : "mention",
      rawText,
      replyContext,
      savedAttachments,
    });

    route.manifest.primaryMessageId = undefined;

    await route.journal.append({
      kind: "inbound",
      sourceId: message.id,
      routeKey: route.manifest.routeKey,
      timestamp: Date.now(),
      text: rawText,
      promptText,
      authorId: message.author.id,
      authorName: message.author.username,
      attachments: savedAttachments,
    });

    await route.queue.enqueue({
      source: {
        kind: "message",
        sourceId: message.id,
        userId: message.author.id,
        guildId: message.guildId ?? null,
        channelId: scope.channelId,
        threadId: scope.threadId,
        trigger: isDm ? "dm" : "mention",
      },
      payload: {
        rawText,
        promptText,
        attachments: savedAttachments,
      },
    });
    await this.scheduleWork();
  }

  async handleInteraction(interaction) {
    if (interaction.isButton()) {
      const [namespace, action, routeKey] = interaction.customId.split(":");
      if (namespace !== "pi-discord" || action !== "stop" || !routeKey) {
        return;
      }
      const authorization = authorizeInteraction(interaction, this.config);
      if (!authorization.allowed) {
        await interaction.reply({ content: authorization.reason ?? "Not allowed.", ephemeral: true });
        return;
      }
      if (!authorization.canControl) {
        await interaction.reply({ content: "Only admin Discord user ids may stop active runs.", ephemeral: true });
        return;
      }
      const stopped = await this.abortRoute(routeKey);
      await interaction.reply({
        content: stopped ? `Stop requested for ${routeKey}.` : `No active run for ${routeKey}.`,
        ephemeral: true,
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== this.config.commandName) return;

    const authorization = authorizeInteraction(interaction, this.config);
    if (!authorization.allowed) {
      if (interaction.isRepliable()) {
        const responder = interaction.deferred || interaction.replied ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
        await responder({ content: authorization.reason ?? "Not allowed.", ephemeral: true });
      }
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "status") {
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel);
      const route = await this.getExistingRoute(scope);
      if (!route) {
        await interaction.reply({ content: `Route ${scope.routeKey} has no saved state yet.`, ephemeral: true });
        return;
      }
      const queued = route.queue.list().filter((item) => item.state === "queued").length;
      const running = route.queue.list().filter((item) => item.state === "running" || item.state === "leased").length;
      await interaction.reply({ content: `Route ${route.manifest.routeKey}\nQueued: ${queued}\nRunning: ${running}`, ephemeral: true });
      return;
    }

    if (subcommand === "stop") {
      if (!authorization.canControl) {
        await interaction.reply({ content: "Only admin Discord user ids may stop active runs.", ephemeral: true });
        return;
      }
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel);
      const stopped = await this.abortRoute(scope.routeKey);
      await interaction.reply({
        content: stopped ? `Stop requested for ${scope.routeKey}.` : `No active run for ${scope.routeKey}.`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "reset") {
      if (!authorization.canControl) {
        await interaction.reply({ content: "Only admin Discord user ids may reset routes.", ephemeral: true });
        return;
      }
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel);
      await this.abortRoute(scope.routeKey);
      const route = await this.getExistingRoute(scope);
      if (!route) {
        await interaction.reply({ content: `Route ${scope.routeKey} has no saved state to reset.`, ephemeral: true });
        return;
      }
      await route.host.dispose();
      route.manifest.sessionFile = undefined;
      await this.registry.saveManifest(route.manifest);
      await interaction.reply({ content: `Reset route ${scope.routeKey}.`, ephemeral: true });
      return;
    }

    if (subcommand !== "ask") return;

    const rawText = interaction.options.getString("text", true).trim();
    const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel);
    const route = await this.ensureRoute(scope);
    if (route.journal.hasSource(interaction.id) || route.queue.hasSource(interaction.id)) {
      await interaction.reply({ content: "That interaction was already queued.", ephemeral: true });
      return;
    }

    const promptText = buildPromptText({
      routeKey: route.manifest.routeKey,
      scope: route.manifest.scope,
      requester: { id: interaction.user.id, name: interaction.user.username },
      trigger: "slash-command",
      rawText,
      savedAttachments: [],
    });

    await interaction.deferReply({ ephemeral: false });
    const reply = await interaction.editReply({
      content: `Queued for <@${interaction.user.id}>`,
      components: route.renderer.createStopRow(),
      allowedMentions: { parse: [] },
    });
    route.manifest.primaryMessageId = reply.id;
    await this.registry.saveManifest(route.manifest);

    await route.journal.append({
      kind: "interaction",
      sourceId: interaction.id,
      routeKey: route.manifest.routeKey,
      timestamp: Date.now(),
      text: rawText,
      promptText,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
    });

    await route.queue.enqueue({
      source: {
        kind: "interaction",
        sourceId: interaction.id,
        userId: interaction.user.id,
        guildId: interaction.guildId ?? null,
        channelId: scope.channelId,
        threadId: scope.threadId,
        trigger: "slash-command",
      },
      payload: {
        rawText,
        promptText,
        attachments: [],
      },
    });
    await this.scheduleWork();
  }

  async saveInboundAttachments(route, attachments, sourceId) {
    const saved = [];
    for (const attachment of attachments) {
      const extension = path.extname(attachment.name ?? "") || ".bin";
      const filePath = path.join(route.routePaths.inboundAttachmentsDir, `${sourceId}-${attachment.id}${extension}`);
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to download attachment ${attachment.url}: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(filePath, buffer);
      saved.push({
        id: attachment.id,
        path: filePath,
        name: attachment.name ?? path.basename(filePath),
        contentType: attachment.contentType ?? undefined,
        isImage: (attachment.contentType ?? "").startsWith("image/"),
      });
    }
    return saved;
  }

  async fetchReplyContext(message) {
    try {
      const replied = await message.fetchReference();
      return `${replied.author?.username ?? "unknown"}: ${(replied.content ?? "").slice(0, 400)}`;
    } catch {
      return undefined;
    }
  }

  async scheduleWork() {
    if (this.stopping) return;
    for (const route of this.routeContexts.values()) {
      if (this.currentRuns.size >= this.config.globalConcurrency) return;
      if (this.currentRuns.has(route.manifest.routeKey)) continue;
      const leased = await route.queue.leaseNext(this.workerId);
      if (!leased) continue;
      this.currentRuns.set(route.manifest.routeKey, { abort: async () => {
        const session = await route.host.ensureSession();
        await session.abort();
      } });
      this.runInBackground("status-write-failed", async () => {
        await this.writeStatus();
      }, { routeKey: route.manifest.routeKey });
      void this.processQueueItem(route, leased)
        .catch(async (error) => {
          await this.logger.error("queue-item-processing-failed", {
            routeKey: route.manifest.routeKey,
            itemId: leased.id,
            error: String(error),
          });
        })
        .finally(() => {
          this.currentRuns.delete(route.manifest.routeKey);
          this.runInBackground("status-write-failed", async () => {
            await this.writeStatus();
          }, { routeKey: route.manifest.routeKey });
          this.runInBackground("schedule-work-failed", async () => {
            await this.scheduleWork();
          }, { routeKey: route.manifest.routeKey });
        });
    }
  }

  async processQueueItem(route, leasedItem) {
    let heartbeat;
    let unsubscribe = () => undefined;
    const isTrigger = leasedItem.source.kind === "trigger";
    let assistantText = "";

    try {
      await route.queue.markRunning(leasedItem.id);
      route.host.currentSourceId = leasedItem.source.sourceId;
      const session = await route.host.ensureSession();
      await this.registry.saveManifest(route.manifest);

      heartbeat = setInterval(() => {
        this.runInBackground("queue-heartbeat-failed", async () => {
          await route.queue.heartbeat(leasedItem.id);
        }, { routeKey: route.manifest.routeKey, itemId: leasedItem.id });
      }, Math.max(1_000, Math.floor(this.config.queueLeaseMs / 3)));

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          assistantText += event.assistantMessageEvent.delta;
        }
      });

      const modelSupportsImages = this.config.enableImageInput && (session.model?.input?.includes?.("image") ?? false);
      const images = modelSupportsImages
        ? await Promise.all(
            leasedItem.payload.attachments
              .filter((attachment) => attachment.isImage && attachment.contentType)
              .map((attachment) => toImageContent(attachment.path, attachment.contentType)),
          )
        : [];
      await session.prompt(leasedItem.payload.promptText, {
        expandPromptTemplates: false,
        source: "extension",
        images,
      });
      route.manifest.sessionFile = session.sessionFile;
      await this.registry.saveManifest(route.manifest);
      await route.queue.finish(leasedItem.id, "completed");

      const shouldPost = assistantText.trim() && !(isTrigger && assistantText.includes("[NO_OUTREACH]"));
      if (shouldPost) {
        const channel = await route.renderer.getTargetChannel();
        for (const chunk of splitDiscordText(assistantText)) {
          await channel.send({ content: chunk, allowedMentions: { parse: [] } });
        }
      }

      let journalKind = "assistant-final";
      if (isTrigger) {
        journalKind = assistantText.includes("[NO_OUTREACH]") ? "trigger-suppressed" : "trigger-sent";
      }
      await route.journal.append({
        kind: journalKind,
        routeKey: route.manifest.routeKey,
        timestamp: Date.now(),
        sourceId: leasedItem.id,
        text: assistantText,
      });
    } catch (error) {
      const text = String(error);
      const nextState = /abort/i.test(text) ? "cancelled" : "failed";
      await route.queue.finish(leasedItem.id, nextState, text);
      await this.registry.saveManifest(route.manifest);
      await route.journal.append({
        kind: nextState === "cancelled" ? "assistant-cancelled" : "assistant-error",
        routeKey: route.manifest.routeKey,
        timestamp: Date.now(),
        sourceId: leasedItem.id,
        error: text,
      });
      if (!isTrigger) {
        const errorMsg = nextState === "cancelled"
          ? "Run stopped."
          : `Something went wrong. (${text.slice(0, 200)})`;
        const channel = await route.renderer.getTargetChannel().catch(() => undefined);
        if (channel) {
          await channel.send({ content: errorMsg, allowedMentions: { parse: [] } }).catch(() => undefined);
        }
      }
    } finally {
      route.host.currentSourceId = undefined;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    }
  }

  async abortRoute(routeKey) {
    const active = this.currentRuns.get(routeKey);
    if (active) {
      await active.abort();
      return true;
    }
    return false;
  }

  async reconcileKnownRoutes() {
    for (const summary of this.registry.list()) {
      try {
        const route = await this.ensureRoute({ ...summary.scope, routeKey: summary.routeKey });
        const channel = await this.client.channels.fetch(route.manifest.scope.threadId ?? route.manifest.scope.channelId);
        if (!channel || !("messages" in channel)) continue;
        const recent = await channel.messages.fetch({ limit: 15 });
        for (const message of [...recent.values()].reverse()) {
          if (message.author?.bot) continue;
          if (!authorizeInteraction(message, this.config).allowed) continue;
          if (route.journal.hasSource(message.id)) continue;
          await route.journal.append({
            kind: "ambient",
            sourceId: message.id,
            routeKey: route.manifest.routeKey,
            timestamp: message.createdTimestamp,
            text: message.content ?? "",
            authorId: message.author?.id,
            authorName: message.author?.username,
          });
        }
      } catch (error) {
        await this.logger.warn("route-reconcile-failed", { routeKey: summary.routeKey, error: String(error) });
      }
    }
  }

  async writeStatus(extra = {}) {
    this.status = {
      ...this.status,
      ...extra,
      pid: process.pid,
      routeCount: this.registry.list().length,
      activeRuns: [...this.currentRuns.keys()],
    };
    await writeJson(this.paths.statusPath, this.status);
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.triggerInterval) clearInterval(this.triggerInterval);
    for (const active of this.currentRuns.values()) {
      await active.abort().catch(() => undefined);
    }
    this.currentRuns.clear();
    for (const route of this.routeContexts.values()) {
      await route.host.dispose();
    }
    await this.writeStatus({ phase: "stopping" });
    this.client.destroy();
    await removeIfExists(this.paths.pidPath);
    await removeIfExists(this.paths.lockPath);
  }
}
