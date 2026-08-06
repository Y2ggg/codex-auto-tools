#!/usr/bin/env node

import { EventEmitter } from "node:events";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const VERSION = "0.2.0";
const DEFAULT_RETRY_MAX = 6;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_RECONNECT_STALL_MS = 120000;
const DEFAULT_RECONNECT_RECOVERY_MAX = 3;
const DISCOVERY_INTERVAL_MS = 400;
const CONTINUATION_PROMPT =
  "上一轮因模型容量不足而中断。请从当前会话上下文继续完成原任务；不要重复已经完成的步骤。";
const RECONNECT_CONTINUATION_PROMPT =
  "上一轮因网络重连长时间无进展，已自动中断。请从当前会话上下文继续完成原任务；不要重复已经完成的步骤。";
const STREAM_PROGRESS_METHODS = new Set([
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unrefSleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function envBoolean(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function envInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function findExecutable(name) {
  const override = process.env.CODEX_CAPACITY_RETRY_CODEX_BIN;
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((directory) => join(directory, name));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
    }
  }
  throw new Error(
    override
      ? `CODEX_CAPACITY_RETRY_CODEX_BIN is not executable: ${override}`
      : `Unable to find ${name} in PATH`,
  );
}

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
  }

  write(message, details) {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    appendFileSync(
      this.filePath,
      `${new Date().toISOString()} ${message}${suffix}\n`,
      "utf8",
    );
  }
}

class UnixWebSocket extends EventEmitter {
  constructor(socket, clientKey) {
    super();
    this.socket = socket;
    this.clientKey = clientKey;
    this.open = false;
    this.closeSent = false;
    this.closed = false;
    this.handshakeBuffer = Buffer.alloc(0);
    this.frameBuffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];

    this.on("error", () => {});
  }

  static async connect(socketPath, timeoutMs = 5000) {
    const socket = createConnection({ path: socketPath });
    const clientKey = randomBytes(16).toString("base64");
    const webSocket = new UnixWebSocket(socket, clientKey);

    let timeout;
    const opened = new Promise((resolve, reject) => {
      const fail = (error) => {
        clearTimeout(timeout);
        reject(error);
      };

      webSocket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      webSocket.once("handshakeError", fail);
      socket.once("error", fail);

      timeout = setTimeout(() => {
        socket.destroy();
        fail(new Error(`Timed out connecting to Unix socket ${socketPath}`));
      }, timeoutMs);
    });

    socket.on("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${clientKey}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => webSocket._onData(chunk));
    socket.on("error", (error) => {
      if (webSocket.open) webSocket.emit("error", error);
    });
    socket.on("close", () => webSocket._markClosed());

    await opened;
    return webSocket;
  }

  _onData(chunk) {
    if (!this.open) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
      if (this.handshakeBuffer.length > 64 * 1024) {
        this._handshakeFailed(new Error("WebSocket handshake headers are too large"));
        return;
      }

      const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerText = this.handshakeBuffer.subarray(0, headerEnd).toString("utf8");
      const remainder = this.handshakeBuffer.subarray(headerEnd + 4);
      this.handshakeBuffer = Buffer.alloc(0);

      const lines = headerText.split("\r\n");
      if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? "")) {
        this._handshakeFailed(
          new Error(`WebSocket upgrade failed: ${lines[0] || "empty response"}`),
        );
        return;
      }

      const headers = new Map();
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(":");
        if (separator !== -1) {
          headers.set(
            line.slice(0, separator).trim().toLowerCase(),
            line.slice(separator + 1).trim(),
          );
        }
      }

      const expectedAccept = createHash("sha1")
        .update(`${this.clientKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      if (headers.get("sec-websocket-accept") !== expectedAccept) {
        this._handshakeFailed(new Error("Invalid Sec-WebSocket-Accept header"));
        return;
      }

      this.open = true;
      this.emit("open");
      if (remainder.length > 0) this._consumeFrames(remainder);
      return;
    }

    this._consumeFrames(chunk);
  }

  _handshakeFailed(error) {
    this.emit("handshakeError", error);
    this.socket.destroy();
  }

  _consumeFrames(chunk) {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

    while (this.frameBuffer.length >= 2) {
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.frameBuffer.length < 4) return;
        payloadLength = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.frameBuffer.length < 10) return;
        const longLength = this.frameBuffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this._protocolError("WebSocket frame exceeds the safe integer range");
          return;
        }
        payloadLength = Number(longLength);
        offset = 10;
      }

      const controlFrame = opcode >= 0x8;
      if (controlFrame && (!fin || payloadLength > 125)) {
        this._protocolError("Invalid WebSocket control frame");
        return;
      }

      const maskLength = masked ? 4 : 0;
      if (this.frameBuffer.length < offset + maskLength + payloadLength) return;

      let mask;
      if (masked) {
        mask = this.frameBuffer.subarray(offset, offset + 4);
        offset += 4;
      }
      let payload = Buffer.from(this.frameBuffer.subarray(offset, offset + payloadLength));
      this.frameBuffer = this.frameBuffer.subarray(offset + payloadLength);

      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      this._handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      if (!this.closeSent) this._sendFrame(0x8, payload);
      this.socket.end();
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0x0a, payload);
      return;
    }
    if (opcode === 0x0a) return;

    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) {
        this._protocolError("Unexpected WebSocket continuation frame");
        return;
      }
      this.fragments.push(payload);
      if (fin) {
        const completeOpcode = this.fragmentOpcode;
        const completePayload = Buffer.concat(this.fragments);
        this.fragmentOpcode = null;
        this.fragments = [];
        this._emitDataFrame(completeOpcode, completePayload);
      }
      return;
    }

    if (opcode !== 0x1 && opcode !== 0x2) {
      this._protocolError(`Unsupported WebSocket opcode ${opcode}`);
      return;
    }
    if (this.fragmentOpcode !== null) {
      this._protocolError("Received a new data frame during fragmentation");
      return;
    }
    if (fin) {
      this._emitDataFrame(opcode, payload);
    } else {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    }
  }

  _emitDataFrame(opcode, payload) {
    if (opcode === 0x1) this.emit("message", payload.toString("utf8"));
  }

  _protocolError(message) {
    this.emit("error", new Error(message));
    try {
      this.close(1002, message.slice(0, 100));
    } finally {
      this.socket.destroy();
    }
  }

  _sendFrame(opcode, data) {
    if (!this.open || this.closed) throw new Error("WebSocket is not open");
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const mask = randomBytes(4);
    let header;

    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | opcode;

    const maskedPayload = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      maskedPayload[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  sendText(text) {
    this._sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(code = 1000, reason = "") {
    if (!this.open || this.closed || this.closeSent) return;
    this.closeSent = true;
    const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this.socket.end();
  }

  _markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit("close");
  }
}

class RpcClient extends EventEmitter {
  constructor(webSocket, logger) {
    super();
    this.webSocket = webSocket;
    this.logger = logger;
    this.nextId = 1;
    this.pending = new Map();

    webSocket.on("message", (text) => this._onMessage(text));
    webSocket.on("error", (error) => this.emit("error", error));
    webSocket.on("close", () => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(new Error("app-server WebSocket closed"));
      }
      this.pending.clear();
      this.emit("close");
    });
  }

  _onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      this.logger.write("invalid JSON from app-server", { error: error.message });
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if ("error" in message) {
        const error = new Error(
          message.error?.message ?? `JSON-RPC request ${pending.method} failed`,
        );
        error.rpcError = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        this.logger.write("ignored server request", { method: message.method });
        return;
      }
      this.emit("notification", message);
    }
  }

  request(method, params, timeoutMs = 10000) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { method, id };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.webSocket.sendText(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.webSocket.sendText(JSON.stringify(message));
  }

  close() {
    this.webSocket.close();
  }
}

class CapacityRetryController {
  constructor({
    rpc,
    logger,
    retryMax,
    retryDelayMs,
    reconnectStallMs = DEFAULT_RECONNECT_STALL_MS,
    reconnectRecoveryMax = DEFAULT_RECONNECT_RECOVERY_MAX,
    sleeper = unrefSleep,
  }) {
    this.rpc = rpc;
    this.logger = logger;
    this.retryMax = retryMax;
    this.retryDelayMs = retryDelayMs;
    this.reconnectStallMs = reconnectStallMs;
    this.reconnectRecoveryMax = reconnectRecoveryMax;
    this.sleeper = sleeper;
    this.threads = new Map();
    this.tasks = new Set();
    this.stopped = false;
  }

  _state(threadId) {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        effort: null,
        retries: 0,
        activeTurnId: null,
        latestTurnId: null,
        pendingFailures: new Map(),
        handledFailures: new Set(),
        completedTurns: new Map(),
        subscriptionPromise: null,
        subscribed: false,
        reconnectWatch: null,
        reconnectRecoveries: 0,
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  _track(promise) {
    this.tasks.add(promise);
    promise.finally(() => this.tasks.delete(promise));
    return promise;
  }

  async drain() {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  async subscribe(threadId, refresh = false) {
    const state = this._state(threadId);
    if (state.subscriptionPromise) return state.subscriptionPromise;
    if (state.subscribed && !refresh) return state;

    const promise = this.rpc
      .request("thread/resume", { threadId, excludeTurns: true }, 15000)
      .then((response) => {
        state.subscribed = true;
        if (response?.reasoningEffort) state.effort = response.reasoningEffort;
        this.logger.write("subscribed to thread", {
          threadId,
          effort: state.effort,
        });
        return state;
      })
      .catch((error) => {
        this.logger.write("thread subscription failed", {
          threadId,
          error: error.message,
        });
        throw error;
      })
      .finally(() => {
        state.subscriptionPromise = null;
      });
    state.subscriptionPromise = promise;
    return promise;
  }

  observeThreadEffort(threadId, effort) {
    if (!threadId || !effort) return;
    this._state(threadId).effort = effort;
  }

  observeManualInterrupt(threadId, turnId) {
    const state = this.threads.get(threadId);
    if (
      state?.reconnectWatch?.turnId === turnId &&
      ["watching", "interrupting"].includes(state.reconnectWatch.phase)
    ) {
      const phase = state.reconnectWatch.phase;
      state.reconnectWatch = null;
      this.logger.write("reconnect watchdog cancelled by client interrupt", {
        threadId,
        turnId,
        phase,
      });
    }
  }

  handleNotification(message) {
    const { method, params = {} } = message;
    const threadId = params.threadId ?? params.thread?.id;

    if (method === "thread/started" && threadId) {
      this._track(this.subscribe(threadId).catch(() => {}));
      return;
    }

    if (!threadId) return;
    const state = this._state(threadId);

    if (method === "thread/settings/updated") {
      const effort = params.threadSettings?.effort;
      if (effort) state.effort = effort;
      return;
    }

    if (method === "turn/started") {
      const turnId = params.turn?.id ?? null;
      if (state.reconnectWatch && state.reconnectWatch.turnId !== turnId) {
        state.reconnectWatch = null;
      }
      state.activeTurnId = turnId;
      state.latestTurnId = state.activeTurnId;
      this.logger.write("turn started", {
        threadId,
        turnId: state.activeTurnId,
      });
      return;
    }

    if (
      params.turnId &&
      STREAM_PROGRESS_METHODS.has(method) &&
      state.reconnectWatch?.turnId === params.turnId &&
      state.reconnectWatch.phase === "watching"
    ) {
      state.reconnectWatch = null;
      this.logger.write("response stream recovered before watchdog timeout", {
        threadId,
        turnId: params.turnId,
        method,
      });
      return;
    }

    if (method === "error") {
      const errorInfo = params.error?.codexErrorInfo;
      const retryableStreamError =
        params.willRetry === true &&
        ((errorInfo &&
          typeof errorInfo === "object" &&
          ("responseStreamDisconnected" in errorInfo ||
            "responseStreamConnectionFailed" in errorInfo)) ||
          /stream disconnected|reconnect|retrying sampling request/i.test(
            params.error?.message ?? "",
          ));
      if (retryableStreamError && params.turnId) {
        this._armReconnectWatch(threadId, params.turnId, params.error?.message);
        return;
      }

      const overloaded =
        params.willRetry === false &&
        (params.error?.codexErrorInfo === "serverOverloaded" ||
          params.error?.message?.includes(
            "Selected model is at capacity. Please try a different model.",
          ));
      if (!overloaded || !params.turnId) return;
      if (state.handledFailures.has(params.turnId)) return;

      const existing = state.pendingFailures.get(params.turnId);
      if (!existing) {
        state.pendingFailures.set(params.turnId, { scheduled: false });
        this.logger.write("capacity failure detected", {
          threadId,
          turnId: params.turnId,
          effort: state.effort,
        });
      }
      if (state.completedTurns.has(params.turnId)) {
        this._scheduleRetry(threadId, params.turnId);
      }
      return;
    }

    if (method === "turn/completed" && params.turn?.id) {
      const turnId = params.turn.id;
      if (
        state.reconnectWatch?.turnId === turnId &&
        state.reconnectWatch.phase === "watching"
      ) {
        state.reconnectWatch = null;
      }
      state.latestTurnId = turnId;
      this.logger.write("turn completed", {
        threadId,
        turnId,
        status: params.turn.status,
      });
      state.completedTurns.set(turnId, params.turn.status);
      while (state.completedTurns.size > 50) {
        state.completedTurns.delete(state.completedTurns.keys().next().value);
      }
      if (state.activeTurnId === turnId) state.activeTurnId = null;

      if (state.pendingFailures.has(turnId)) {
        this._scheduleRetry(threadId, turnId);
      } else if (params.turn.status === "completed") {
        state.retries = 0;
        state.reconnectRecoveries = 0;
      }
    }
  }

  _scheduleRetry(threadId, failedTurnId) {
    const state = this._state(threadId);
    const failure = state.pendingFailures.get(failedTurnId);
    if (!failure || failure.scheduled || this.stopped) return;
    failure.scheduled = true;
    state.handledFailures.add(failedTurnId);
    while (state.handledFailures.size > 50) {
      state.handledFailures.delete(state.handledFailures.values().next().value);
    }
    this._track(this._retry(threadId, failedTurnId).catch(() => {}));
  }

  _armReconnectWatch(threadId, turnId, message) {
    const state = this._state(threadId);
    if (state.latestTurnId && state.latestTurnId !== turnId) return;
    if (state.reconnectWatch?.turnId === turnId) return;

    const watch = {
      turnId,
      phase: "watching",
      startedAt: Date.now(),
    };
    state.reconnectWatch = watch;
    this.logger.write("response stream reconnect watchdog armed", {
      threadId,
      turnId,
      stallMs: this.reconnectStallMs,
      message,
    });
    this._track(this._recoverReconnect(threadId, watch).catch(() => {}));
  }

  async _recoverReconnect(threadId, watch) {
    const state = this._state(threadId);
    await this.sleeper(this.reconnectStallMs);
    if (this.stopped || state.reconnectWatch !== watch) return;

    if (state.latestTurnId && state.latestTurnId !== watch.turnId) {
      state.reconnectWatch = null;
      return;
    }

    const shouldContinue =
      state.reconnectRecoveries < this.reconnectRecoveryMax;
    watch.phase = "interrupting";
    this.logger.write("interrupting stalled reconnect turn", {
      threadId,
      turnId: watch.turnId,
      stalledForMs: Date.now() - watch.startedAt,
      recoveryAttempt: state.reconnectRecoveries + 1,
      willContinue: shouldContinue,
    });

    try {
      await this.rpc.request(
        "turn/interrupt",
        { threadId, turnId: watch.turnId },
        15000,
      );
    } catch (error) {
      state.reconnectWatch = null;
      this.logger.write("failed to interrupt stalled reconnect turn", {
        threadId,
        turnId: watch.turnId,
        error: error.message,
      });
      return;
    }
    if (this.stopped || state.reconnectWatch !== watch) return;

    const completed = await this._waitForTurnCompletion(
      threadId,
      watch.turnId,
      15000,
    );
    if (this.stopped || state.reconnectWatch !== watch) return;
    if (!completed) {
      state.reconnectWatch = null;
      this.logger.write("interrupted reconnect turn did not complete in time", {
        threadId,
        turnId: watch.turnId,
      });
      return;
    }

    if (!shouldContinue) {
      state.reconnectWatch = null;
      this.logger.write("reconnect recovery limit reached after interrupt", {
        threadId,
        recoveries: state.reconnectRecoveries,
      });
      return;
    }

    if (state.latestTurnId && state.latestTurnId !== watch.turnId) {
      state.reconnectWatch = null;
      return;
    }

    try {
      await this.subscribe(threadId, true);
    } catch {
      state.reconnectWatch = null;
      return;
    }

    if (this.stopped || state.reconnectWatch !== watch) return;
    if (state.latestTurnId && state.latestTurnId !== watch.turnId) {
      state.reconnectWatch = null;
      return;
    }

    state.reconnectRecoveries += 1;
    state.reconnectWatch = null;
    this.logger.write("starting reconnect recovery turn", {
      threadId,
      interruptedTurnId: watch.turnId,
      recoveryAttempt: state.reconnectRecoveries,
      effort: state.effort,
    });

    try {
      const response = await this.rpc.request(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: RECONNECT_CONTINUATION_PROMPT,
              text_elements: [],
            },
          ],
        },
        15000,
      );
      if (response?.turn?.id) {
        state.activeTurnId = response.turn.id;
        state.latestTurnId = response.turn.id;
      }
    } catch (error) {
      state.reconnectRecoveries -= 1;
      this.logger.write("reconnect recovery turn failed to start", {
        threadId,
        error: error.message,
      });
    }
  }

  async _waitForTurnCompletion(threadId, turnId, timeoutMs) {
    const state = this._state(threadId);
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped && Date.now() < deadline) {
      if (state.completedTurns.has(turnId)) {
        return state.completedTurns.get(turnId);
      }
      await sleep(50);
    }
    return null;
  }

  async _retry(threadId, failedTurnId) {
    const state = this._state(threadId);
    await this.sleeper(this.retryDelayMs);
    if (this.stopped) return;

    if (state.latestTurnId && state.latestTurnId !== failedTurnId) {
      state.pendingFailures.delete(failedTurnId);
      this.logger.write("capacity retry cancelled because a newer turn exists", {
        threadId,
        latestTurnId: state.latestTurnId,
      });
      return;
    }

    if (state.retries >= this.retryMax) {
      state.pendingFailures.delete(failedTurnId);
      this.logger.write("capacity retry limit reached", {
        threadId,
        retries: state.retries,
      });
      return;
    }

    try {
      await this.subscribe(threadId, true);
    } catch {
      state.pendingFailures.delete(failedTurnId);
      return;
    }

    const previousEffort = state.effort;
    const nextEffort = previousEffort === "medium" ? "xhigh" : "medium";
    state.retries += 1;
    state.pendingFailures.delete(failedTurnId);

    this.logger.write("starting capacity recovery turn", {
      threadId,
      failedTurnId,
      attempt: state.retries,
      previousEffort,
      nextEffort,
    });

    try {
      const response = await this.rpc.request(
        "turn/start",
        {
          threadId,
          effort: nextEffort,
          input: [
            {
              type: "text",
              text: CONTINUATION_PROMPT,
              text_elements: [],
            },
          ],
        },
        15000,
      );
      state.effort = nextEffort;
      if (response?.turn?.id) {
        state.activeTurnId = response.turn.id;
        state.latestTurnId = response.turn.id;
      }
    } catch (error) {
      state.retries -= 1;
      this.logger.write("capacity recovery turn failed to start", {
        threadId,
        error: error.message,
      });
    }
  }

  stop() {
    this.stopped = true;
  }
}

async function initializeRpc(socketPath, logger) {
  const webSocket = await UnixWebSocket.connect(socketPath);
  const rpc = new RpcClient(webSocket, logger);
  await rpc.request("initialize", {
    clientInfo: {
      name: "codex-capacity-retry",
      title: "Codex Capacity Retry",
      version: VERSION,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
  rpc.notify("initialized");
  logger.write("monitor initialized");
  return rpc;
}

async function waitForSocket(socketPath, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app-server exited with code ${child.exitCode}`);
    }
    try {
      const webSocket = await UnixWebSocket.connect(socketPath, 300);
      webSocket.close();
      return;
    } catch {
      await sleep(50);
    }
  }
  throw new Error("Timed out waiting for app-server to accept connections");
}

function childExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
    } else {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  });
}

function printHelp() {
  process.stdout.write(`codex-auto ${VERSION}

Usage:
  codex-auto [Codex TUI options] [PROMPT]

Runs the interactive Codex CLI through a local app-server observer. It recovers
from model-capacity failures by toggling medium/xhigh, and interrupts then resumes
turns whose response stream remains stuck in Reconnecting.

Environment:
  CODEX_CAPACITY_RETRY_MAX       Maximum consecutive retries (default: 6)
  CODEX_CAPACITY_RETRY_DELAY_MS  Delay before each retry in ms (default: 1000)
  CODEX_RECONNECT_STALL_MS       Reconnecting grace period in ms (default: 120000)
  CODEX_RECONNECT_RECOVERY_MAX   Maximum reconnect continuations (default: 3)
  CODEX_CAPACITY_RETRY_DEBUG     Keep the temporary directory and print its log path
  CODEX_CAPACITY_RETRY_CODEX_BIN Explicit path to the real codex executable

Examples:
  codex-auto
  codex-auto -C /path/to/project
  CODEX_CAPACITY_RETRY_MAX=10 codex-auto

Notes:
  This wrapper is for the interactive CLI. It cannot be combined with --remote.
  Run "codex --help" for the underlying CLI options.
`);
}

async function runSelfTest() {
  const starts = [];
  let effort = "xhigh";
  let turnSequence = 0;
  const rpc = {
    async request(method, params) {
      if (method === "thread/resume") return { reasoningEffort: effort };
      if (method === "turn/start") {
        starts.push(params);
        effort = params.effort;
        turnSequence += 1;
        return { turn: { id: `automatic-${turnSequence}` } };
      }
      throw new Error(`Unexpected method in self-test: ${method}`);
    },
  };
  const logger = { write() {} };
  const controller = new CapacityRetryController({
    rpc,
    logger,
    retryMax: 3,
    retryDelayMs: 0,
    sleeper: async () => {},
  });

  await controller.subscribe("thread-1");
  controller.handleNotification({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "original",
      willRetry: false,
      error: { codexErrorInfo: "serverOverloaded" },
    },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "original", status: "failed" } },
  });
  await controller.drain();
  if (starts[0]?.effort !== "medium") {
    throw new Error("Self-test failed: xhigh must toggle to medium");
  }
  controller.handleNotification({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "original",
      willRetry: false,
      error: { codexErrorInfo: "serverOverloaded" },
    },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "original", status: "failed" } },
  });
  await controller.drain();
  if (starts.length !== 1) {
    throw new Error("Self-test failed: duplicate errors must not duplicate retries");
  }

  controller.handleNotification({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "automatic-1",
      willRetry: false,
      error: { codexErrorInfo: "serverOverloaded" },
    },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "automatic-1", status: "failed" },
    },
  });
  await controller.drain();
  if (starts[1]?.effort !== "xhigh") {
    throw new Error("Self-test failed: medium must toggle to xhigh");
  }
  if (starts.some((start) => start.input[0].text_elements === undefined)) {
    throw new Error("Self-test failed: text_elements is required");
  }

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "automatic-2", status: "completed" },
    },
  });
  if (controller.threads.get("thread-1").retries !== 0) {
    throw new Error("Self-test failed: a successful turn must reset the retry counter");
  }

  controller.handleNotification({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "manual-origin",
      willRetry: false,
      error: {
        message: "Selected model is at capacity. Please try a different model.",
      },
    },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "manual-origin", status: "failed" },
    },
  });
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "manual-takeover", status: "inProgress" },
    },
  });
  await controller.drain();
  if (starts.length !== 2) {
    throw new Error("Self-test failed: manual takeover must cancel automatic recovery");
  }

  const reconnectCalls = [];
  let reconnectController;
  const reconnectRpc = {
    async request(method, params) {
      if (method === "thread/resume") return { reasoningEffort: "medium" };
      if (method === "turn/interrupt") {
        reconnectCalls.push({ method, params });
        queueMicrotask(() => {
          reconnectController.handleNotification({
            method: "turn/completed",
            params: {
              threadId: params.threadId,
              turn: { id: params.turnId, status: "interrupted" },
            },
          });
        });
        return {};
      }
      if (method === "turn/start") {
        reconnectCalls.push({ method, params });
        return { turn: { id: "reconnect-continuation" } };
      }
      throw new Error(`Unexpected reconnect method in self-test: ${method}`);
    },
  };
  reconnectController = new CapacityRetryController({
    rpc: reconnectRpc,
    logger,
    retryMax: 3,
    retryDelayMs: 0,
    reconnectStallMs: 0,
    reconnectRecoveryMax: 2,
    sleeper: async () => {},
  });
  await reconnectController.subscribe("reconnect-thread");
  reconnectController.handleNotification({
    method: "turn/started",
    params: {
      threadId: "reconnect-thread",
      turn: { id: "stalled-turn", status: "inProgress" },
    },
  });
  reconnectController.handleNotification({
    method: "error",
    params: {
      threadId: "reconnect-thread",
      turnId: "stalled-turn",
      willRetry: true,
      error: {
        message: "stream disconnected - retrying sampling request",
        codexErrorInfo: {
          responseStreamDisconnected: { httpStatusCode: null },
        },
      },
    },
  });
  await reconnectController.drain();
  if (
    reconnectCalls[0]?.method !== "turn/interrupt" ||
    reconnectCalls[1]?.method !== "turn/start"
  ) {
    throw new Error("Self-test failed: stalled reconnect must interrupt then continue");
  }
  if ("effort" in reconnectCalls[1].params) {
    throw new Error("Self-test failed: reconnect recovery must preserve current effort");
  }
  if (!reconnectCalls[1].params.input[0].text.includes("网络重连")) {
    throw new Error("Self-test failed: reconnect continuation prompt is missing");
  }

  let releaseManualInterrupt;
  let markInterruptStarted;
  let manualRecoveryStarts = 0;
  const interruptStarted = new Promise((resolve) => {
    markInterruptStarted = resolve;
  });
  const manualInterruptController = new CapacityRetryController({
    rpc: {
      async request(method) {
        if (method === "thread/resume") return { reasoningEffort: "medium" };
        if (method === "turn/interrupt") {
          markInterruptStarted();
          return new Promise((resolve) => {
            releaseManualInterrupt = resolve;
          });
        }
        if (method === "turn/start") {
          manualRecoveryStarts += 1;
          return {};
        }
        throw new Error(`Unexpected manual interrupt method in self-test: ${method}`);
      },
    },
    logger,
    retryMax: 3,
    retryDelayMs: 0,
    reconnectStallMs: 0,
    reconnectRecoveryMax: 2,
    sleeper: async () => {},
  });
  await manualInterruptController.subscribe("manual-interrupt-thread");
  manualInterruptController.handleNotification({
    method: "turn/started",
    params: {
      threadId: "manual-interrupt-thread",
      turn: { id: "manual-interrupt-turn", status: "inProgress" },
    },
  });
  manualInterruptController.handleNotification({
    method: "error",
    params: {
      threadId: "manual-interrupt-thread",
      turnId: "manual-interrupt-turn",
      willRetry: true,
      error: {
        codexErrorInfo: { responseStreamDisconnected: {} },
      },
    },
  });
  await interruptStarted;
  manualInterruptController.observeManualInterrupt(
    "manual-interrupt-thread",
    "manual-interrupt-turn",
  );
  releaseManualInterrupt({});
  await manualInterruptController.drain();
  if (manualRecoveryStarts !== 0) {
    throw new Error("Self-test failed: a client interrupt must cancel continuation");
  }

  let releaseReconnectWatch;
  let transientInterrupts = 0;
  const transientController = new CapacityRetryController({
    rpc: {
      async request(method) {
        if (method === "thread/resume") return { reasoningEffort: "xhigh" };
        if (method === "turn/interrupt") transientInterrupts += 1;
        return {};
      },
    },
    logger,
    retryMax: 3,
    retryDelayMs: 0,
    reconnectStallMs: 100,
    reconnectRecoveryMax: 2,
    sleeper: () =>
      new Promise((resolve) => {
        releaseReconnectWatch = resolve;
      }),
  });
  await transientController.subscribe("transient-thread");
  transientController.handleNotification({
    method: "turn/started",
    params: {
      threadId: "transient-thread",
      turn: { id: "transient-turn", status: "inProgress" },
    },
  });
  transientController.handleNotification({
    method: "error",
    params: {
      threadId: "transient-thread",
      turnId: "transient-turn",
      willRetry: true,
      error: {
        message: "stream disconnected",
        codexErrorInfo: {
          responseStreamConnectionFailed: { httpStatusCode: 502 },
        },
      },
    },
  });
  transientController.handleNotification({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "transient-thread",
      turnId: "transient-turn",
      delta: "recovered",
    },
  });
  releaseReconnectWatch();
  await transientController.drain();
  if (transientInterrupts !== 0) {
    throw new Error("Self-test failed: recovered streams must not be interrupted");
  }

  process.stdout.write("codex-auto self-test: ok\n");
}

async function run(args) {
  if (args.includes("--remote") || args.some((argument) => argument.startsWith("--remote="))) {
    throw new Error("codex-auto manages --remote internally; remove that option");
  }

  const debug = envBoolean("CODEX_CAPACITY_RETRY_DEBUG");
  const retryMax = envInteger(
    "CODEX_CAPACITY_RETRY_MAX",
    DEFAULT_RETRY_MAX,
    0,
    100,
  );
  const retryDelayMs = envInteger(
    "CODEX_CAPACITY_RETRY_DELAY_MS",
    DEFAULT_RETRY_DELAY_MS,
    0,
    300000,
  );
  const reconnectStallMs = envInteger(
    "CODEX_RECONNECT_STALL_MS",
    DEFAULT_RECONNECT_STALL_MS,
    1000,
    3600000,
  );
  const reconnectRecoveryMax = envInteger(
    "CODEX_RECONNECT_RECOVERY_MAX",
    DEFAULT_RECONNECT_RECOVERY_MAX,
    0,
    100,
  );
  const codexBinary = findExecutable("codex");
  const runDirectory = mkdtempSync(join(tmpdir(), "codex-capacity-retry-"));
  const socketPath = join(runDirectory, "app-server.sock");
  const logPath = join(runDirectory, "codex-auto.log");
  const logFd = openSync(logPath, "a");
  const logger = new Logger(logPath);
  logger.write("starting", {
    version: VERSION,
    codexBinary,
    retryMax,
    retryDelayMs,
    reconnectStallMs,
    reconnectRecoveryMax,
  });

  if (debug) process.stderr.write(`[codex-auto] debug log: ${logPath}\n`);

  let appServer;
  let tui;
  let rpc;
  let controller;
  let discoveryStopped = false;
  let abnormal = false;
  let shuttingDown = false;
  let receivedSignal = null;
  const signalHandlers = new Map();

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeSignalHandlers();
    discoveryStopped = true;
    controller?.stop();
    rpc?.close();

    if (appServer && appServer.exitCode === null && appServer.signalCode === null) {
      appServer.kill("SIGTERM");
      const exited = childExit(appServer);
      await Promise.race([exited, sleep(1500)]);
      if (appServer.exitCode === null && appServer.signalCode === null) {
        appServer.kill("SIGKILL");
        await childExit(appServer);
      }
    }
    closeSync(logFd);

    if (!debug && !abnormal) {
      rmSync(runDirectory, { recursive: true, force: true });
    }
  };

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (receivedSignal) return;
      receivedSignal = signal;
      discoveryStopped = true;
      controller?.stop();
      logger.write("received signal", { signal });
      if (tui && tui.exitCode === null && tui.signalCode === null) {
        tui.kill(signal);
      } else if (
        appServer &&
        appServer.exitCode === null &&
        appServer.signalCode === null
      ) {
        appServer.kill("SIGTERM");
      }
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    appServer = spawn(
      codexBinary,
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );
    appServer.on("error", (error) => logger.write("app-server spawn error", { error: error.message }));

    await waitForSocket(socketPath, appServer);
    rpc = await initializeRpc(socketPath, logger);
    controller = new CapacityRetryController({
      rpc,
      logger,
      retryMax,
      retryDelayMs,
      reconnectStallMs,
      reconnectRecoveryMax,
    });
    rpc.on("notification", (message) => controller.handleNotification(message));
    rpc.on("error", (error) => logger.write("monitor WebSocket error", { error: error.message }));

    const discover = async () => {
      while (!discoveryStopped) {
        try {
          const response = await rpc.request(
            "thread/loaded/list",
            { limit: 100 },
            5000,
          );
          for (const threadId of response?.data ?? []) {
            await controller.subscribe(threadId).catch(() => {});
          }
        } catch (error) {
          if (!discoveryStopped) {
            logger.write("thread discovery failed", { error: error.message });
          }
        }
        await sleep(DISCOVERY_INTERVAL_MS);
      }
    };
    const discoveryTask = discover();

    tui = spawn(codexBinary, ["--remote", `unix://${socketPath}`, ...args], {
      stdio: "inherit",
      env: process.env,
    });

    appServer.once("exit", (code, signal) => {
      if (
        !shuttingDown &&
        !receivedSignal &&
        tui?.exitCode === null &&
        tui?.signalCode === null
      ) {
        abnormal = true;
        logger.write("app-server exited while TUI was running", { code, signal });
        tui.kill("SIGTERM");
      }
    });

    const result = await childExit(tui);
    discoveryStopped = true;
    await discoveryTask;
    await cleanup();

    if (abnormal) {
      process.stderr.write(`[codex-auto] app-server stopped unexpectedly; log: ${logPath}\n`);
      return 1;
    }
    if (receivedSignal || result.signal) {
      const signal = receivedSignal ?? result.signal;
      const signalNumber = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 0;
      return 128 + signalNumber;
    }
    return result.code ?? 0;
  } catch (error) {
    if (receivedSignal) {
      logger.write("interrupted during startup", { signal: receivedSignal });
      await cleanup();
      const signalNumber = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[receivedSignal] ?? 0;
      return 128 + signalNumber;
    }
    abnormal = true;
    logger.write("fatal error", { error: error.stack ?? error.message });
    await cleanup();
    process.stderr.write(`[codex-auto] ${error.message}\n[codex-auto] log: ${logPath}\n`);
    return 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();
    return 0;
  }
  if (args.length === 1 && args[0] === "--self-test") {
    await runSelfTest();
    return 0;
  }
  return run(args);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[codex-auto] ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}

export { CapacityRetryController, RpcClient, UnixWebSocket };
