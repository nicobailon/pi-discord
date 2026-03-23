import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";

/**
 * @typedef {Object} QueueItem
 * @property {string} id
 * @property {"queued" | "leased" | "running" | "completed" | "failed" | "cancelled"} state
 * @property {string | undefined} error
 * @property {{ kind: "message" | "interaction", sourceId: string, userId: string, guildId: string | null, channelId: string, threadId: string | null, trigger: string }} source
 * @property {{ rawText: string, promptText: string, attachments: Array<{ path: string, name: string, contentType?: string, isImage: boolean }> }} payload
 * @property {{ workerId: string, acquiredAt: number, expiresAt: number } | undefined} lease
 */

const QUEUE_STATES = new Set(["queued", "leased", "running", "completed", "failed", "cancelled"]);

function normalizeAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.path !== "string" || typeof value.name !== "string") return undefined;
  return {
    path: value.path,
    name: value.name,
    contentType: typeof value.contentType === "string" ? value.contentType : undefined,
    isImage: Boolean(value.isImage),
  };
}

function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if ((value.kind !== "message" && value.kind !== "interaction" && value.kind !== "trigger")
    || typeof value.sourceId !== "string"
    || typeof value.userId !== "string"
    || typeof value.channelId !== "string"
    || typeof value.trigger !== "string") {
    return undefined;
  }
  return {
    kind: value.kind,
    sourceId: value.sourceId,
    userId: value.userId,
    guildId: typeof value.guildId === "string" ? value.guildId : null,
    channelId: value.channelId,
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    trigger: value.trigger,
  };
}

function normalizeLease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.workerId !== "string"
    || typeof value.acquiredAt !== "number"
    || typeof value.expiresAt !== "number") {
    return undefined;
  }
  return {
    workerId: value.workerId,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
  };
}

function normalizeItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.id !== "string" || !QUEUE_STATES.has(value.state)) return undefined;
  const source = normalizeSource(value.source);
  const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
    ? {
        rawText: typeof value.payload.rawText === "string" ? value.payload.rawText : "",
        promptText: typeof value.payload.promptText === "string" ? value.payload.promptText : "",
        attachments: Array.isArray(value.payload.attachments)
          ? value.payload.attachments.map(normalizeAttachment).filter(Boolean)
          : [],
      }
    : undefined;
  if (!source || !payload) return undefined;

  const lease = normalizeLease(value.lease);
  const state = (value.state === "leased" || value.state === "running") && !lease
    ? "queued"
    : value.state;
  const error = (value.state === "leased" || value.state === "running") && !lease
    ? "Recovered malformed queued work without a valid lease."
    : (typeof value.error === "string" ? value.error : undefined);

  return {
    id: value.id,
    state,
    error,
    source,
    payload,
    lease,
  };
}

function normalizeQueueData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, items: [] };
  }
  return {
    version: 1,
    items: Array.isArray(value.items) ? value.items.map(normalizeItem).filter(Boolean) : [],
  };
}

export class RouteQueueStore {
  /**
   * @param {string} filePath
   * @param {number} leaseMs
   */
  constructor(filePath, leaseMs) {
    this.filePath = filePath;
    this.leaseMs = leaseMs;
    this.data = { version: 1, items: [] };
  }

  async load() {
    this.data = normalizeQueueData(await readJson(this.filePath, { version: 1, items: [] }));
    return this.data;
  }

  async save() {
    await ensureDir(path.dirname(this.filePath));
    await writeJson(this.filePath, this.data);
  }

  list() {
    return this.data.items.slice();
  }

  hasSource(sourceId) {
    return this.data.items.some((item) => item.source.sourceId === sourceId && item.state !== "cancelled");
  }

  /**
   * @param {Omit<QueueItem, 'id' | 'state' | 'lease' | 'error'>} input
   */
  async enqueue(input) {
    const item = {
      id: randomUUID(),
      state: "queued",
      error: undefined,
      lease: undefined,
      ...input,
    };
    this.data.items.push(item);
    await this.save();
    return item;
  }

  async replaceQueuedBySource(sourceId, updater) {
    const item = this.data.items.find((entry) => entry.source.sourceId === sourceId && entry.state === "queued");
    if (!item) return undefined;
    updater(item);
    await this.save();
    return item;
  }

  async cancelQueuedBySource(sourceId, reason = "Cancelled by transport event.") {
    let changed = false;
    for (const item of this.data.items) {
      if (item.source.sourceId === sourceId && item.state === "queued") {
        item.state = "cancelled";
        item.error = reason;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async recoverExpiredLeases(now = Date.now()) {
    let changed = false;
    for (const item of this.data.items) {
      if ((item.state === "leased" || item.state === "running") && item.lease && item.lease.expiresAt <= now) {
        item.state = "queued";
        item.lease = undefined;
        item.error = "Recovered abandoned work after lease expiry.";
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async leaseNext(workerId, now = Date.now()) {
    const item = this.data.items.find((entry) => entry.state === "queued");
    if (!item) return undefined;
    item.state = "leased";
    item.lease = {
      workerId,
      acquiredAt: now,
      expiresAt: now + this.leaseMs,
    };
    await this.save();
    return item;
  }

  async markRunning(itemId) {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item) return undefined;
    item.state = "running";
    if (item.lease) item.lease.expiresAt = Date.now() + this.leaseMs;
    await this.save();
    return item;
  }

  async heartbeat(itemId) {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item || !item.lease) return undefined;
    item.lease.expiresAt = Date.now() + this.leaseMs;
    await this.save();
    return item;
  }

  async finish(itemId, nextState, error) {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item) return undefined;
    item.state = nextState;
    item.error = error;
    item.lease = undefined;
    await this.save();
    return item;
  }
}
