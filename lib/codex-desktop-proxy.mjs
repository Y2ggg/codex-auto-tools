#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { PassThrough, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { CapacityRetryController } from "./codex-capacity-retry.mjs";

const VERSION = "0.2.0";
const MAX_JSON_LINE_LENGTH = 64 * 1024 * 1024;
const DEFAULT_RETRY_MAX = 12;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60000;
const DEFAULT_RECONNECT_STALL_MS = 20000;
const DEFAULT_RECONNECT_RECOVERY_MAX = 3;

function envBoolean(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function envInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function findRealCodex(selfPath) {
  const resourcesPath = process.env.CODEX_ELECTRON_RESOURCES_PATH?.trim();
  const candidates = [
    process.env.CODEX_DESKTOP_REAL_CLI?.trim(),
    resourcesPath ? join(resourcesPath, "codex") : null,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "codex")),
  ].filter(Boolean);
  const selfCanonical = canonical(selfPath);

  for (const candidate of candidates) {
    if (canonical(candidate) === selfCanonical) continue;
    if (executable(candidate)) return candidate;
  }
  throw new Error("Unable to locate the real Codex executable for Desktop");
}

function shouldProxyAppServer(args) {
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex === -1) return false;
  const appServerArgs = args.slice(appServerIndex + 1);
  if (appServerArgs.includes("--help") || appServerArgs.includes("-h")) return false;
  if (
    appServerArgs.some((argument) =>
      ["daemon", "proxy", "generate-ts", "generate-json-schema", "help"].includes(
        argument,
      ),
    )
  ) {
    return false;
  }
  if (
    appServerArgs.includes("--listen") ||
    appServerArgs.some((argument) => argument.startsWith("--listen="))
  ) {
    return false;
  }
  return true;
}

class DesktopLogger {
  constructor(filePath, debug) {
    this.filePath = filePath;
    this.debug = debug;
  }

  write(message, details) {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    const line = `${new Date().toISOString()} ${message}${suffix}\n`;
    appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    if (this.debug) process.stderr.write(`[codex-desktop-auto] ${message}${suffix}\n`);
  }
}

function createLogger() {
  const logDirectory = join(homedir(), ".codex", "desktop-auto");
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  return new DesktopLogger(
    join(logDirectory, "codex-desktop-auto.log"),
    envBoolean("CODEX_DESKTOP_AUTO_DEBUG"),
  );
}

class JsonLineTransform extends Transform {
  constructor(handler, logger, direction) {
    super();
    this.handler = handler;
    this.logger = logger;
    this.direction = direction;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  _transform(chunk, encoding, callback) {
    try {
      this.buffer += this.decoder.write(chunk);
      this._drainLines();
      if (this.buffer.length > MAX_JSON_LINE_LENGTH) {
        throw new Error(`${this.direction} JSON line exceeds size limit`);
      }
      callback();
    } catch (error) {
      this.logger.write("JSONL transform failed", {
        direction: this.direction,
        error: error.message,
      });
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.buffer += this.decoder.end();
      if (this.buffer.length > 0) this._emitLine(this.buffer);
      this.buffer = "";
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _drainLines() {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this._emitLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  _emitLine(line) {
    const output = this.handler(line);
    if (output !== null) this.push(`${output}\n`);
  }
}

function parseLine(line, logger, direction) {
  if (line.trim() === "") return null;
  try {
    return JSON.parse(line);
  } catch (error) {
    logger.write("non-JSON app-server line forwarded", {
      direction,
      error: error.message,
    });
    return null;
  }
}

class StdioRpcClient {
  constructor(child, logger) {
    this.child = child;
    this.logger = logger;
    this.idPrefix = `codex-desktop-auto:${process.pid}:${randomUUID()}:`;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  request(method, params, timeoutMs = 10000) {
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error("Desktop app-server stdin is closed"));
    }
    const id = `${this.idPrefix}${this.nextId}`;
    this.nextId += 1;
    const message = { method, id };
    if (params !== undefined) message.params = params;

    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
        method,
      });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  consume(message) {
    if (message?.id === undefined) return false;
    if (
      typeof message.id !== "string" ||
      !message.id.startsWith(this.idPrefix) ||
      (!("result" in message) && !("error" in message))
    ) {
      return false;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger.write("late proxy-owned JSON-RPC response discarded", {
        id: message.id,
      });
      return true;
    }
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
    return true;
  }

  close(error = new Error("Desktop app-server closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class DesktopRequestObserver {
  constructor(controller) {
    this.controller = controller;
    this.pending = new Map();
  }

  observeClientMessage(message) {
    if (!message || typeof message.method !== "string") return;
    const { method, params = {} } = message;
    if (method === "turn/start" && params.threadId) {
      this.controller.observeManualTurnStart(params.threadId);
    }
    if (
      (method === "turn/start" || method === "thread/settings/update") &&
      params.threadId &&
      params.effort
    ) {
      this.controller.observeThreadEffort(params.threadId, params.effort);
    }
    if (method === "turn/interrupt" && params.threadId && params.turnId) {
      this.controller.observeManualInterrupt(params.threadId, params.turnId);
    }
    if (
      message.id !== undefined &&
      ["thread/start", "thread/resume", "turn/start"].includes(method)
    ) {
      this.pending.set(message.id, { method, params });
      if (this.pending.size > 1000) {
        this.pending.delete(this.pending.keys().next().value);
      }
    }
  }

  observeServerMessage(message) {
    if (!message || message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (!("result" in message)) return;

    const result = message.result;
    const threadId = request.params.threadId ?? result?.thread?.id;
    const effort =
      request.params.effort ?? result?.reasoningEffort ?? result?.threadSettings?.effort;
    if (threadId && effort) this.controller.observeThreadEffort(threadId, effort);
  }
}

function controllerOptions() {
  return {
    retryMax: envInteger(
      "CODEX_CAPACITY_RETRY_MAX",
      DEFAULT_RETRY_MAX,
      0,
      100,
    ),
    retryDelayMs: envInteger(
      "CODEX_CAPACITY_RETRY_DELAY_MS",
      DEFAULT_RETRY_DELAY_MS,
      0,
      300000,
    ),
    retryMaxDelayMs: envInteger(
      "CODEX_CAPACITY_RETRY_MAX_DELAY_MS",
      DEFAULT_RETRY_MAX_DELAY_MS,
      0,
      3600000,
    ),
    reconnectStallMs: envInteger(
      "CODEX_RECONNECT_STALL_MS",
      DEFAULT_RECONNECT_STALL_MS,
      1000,
      3600000,
    ),
    reconnectRecoveryMax: envInteger(
      "CODEX_RECONNECT_RECOVERY_MAX",
      DEFAULT_RECONNECT_RECOVERY_MAX,
      0,
      100,
    ),
  };
}

function signalExitCode(signal) {
  return 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 0);
}

async function delegate(realCodex, args) {
  return new Promise((resolveDelegate, rejectDelegate) => {
    const child = spawn(realCodex, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", rejectDelegate);
    child.once("exit", (code, signal) => {
      resolveDelegate(signal ? signalExitCode(signal) : (code ?? 1));
    });
  });
}

async function proxyAppServer(realCodex, args, logger) {
  const options = controllerOptions();
  const childEnvironment = { ...process.env };
  delete childEnvironment.CODEX_CLI_PATH;
  const child = spawn(realCodex, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnvironment,
  });
  const rpc = new StdioRpcClient(child, logger);
  const controller = new CapacityRetryController({
    rpc,
    logger,
    ...options,
  });
  const requestObserver = new DesktopRequestObserver(controller);

  logger.write("desktop app-server proxy started", {
    version: VERSION,
    pid: process.pid,
    childPid: child.pid,
    realCodex,
    ...options,
  });

  const clientTransform = new JsonLineTransform(
    (line) => {
      const message = parseLine(line, logger, "client-to-server");
      if (message) requestObserver.observeClientMessage(message);
      return line;
    },
    logger,
    "client-to-server",
  );
  const serverTransform = new JsonLineTransform(
    (line) => {
      const message = parseLine(line, logger, "server-to-client");
      if (!message) return line;
      if (rpc.consume(message)) return null;
      requestObserver.observeServerMessage(message);
      if (typeof message.method === "string" && message.id === undefined) {
        controller.handleNotification(message);
      }
      return line;
    },
    logger,
    "server-to-client",
  );

  process.stdin.pipe(clientTransform).pipe(child.stdin);
  child.stdout.pipe(serverTransform).pipe(process.stdout);

  const signalHandlers = new Map();
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      controller.stop();
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return new Promise((resolveProxy, rejectProxy) => {
    child.once("error", (error) => {
      controller.stop();
      rpc.close(error);
      rejectProxy(error);
    });
    child.once("exit", (code, signal) => {
      controller.stop();
      rpc.close();
      process.stdin.unpipe(clientTransform);
      child.stdout.unpipe(serverTransform);
      clientTransform.destroy();
      serverTransform.destroy();
      process.stdin.pause();
      for (const [registeredSignal, handler] of signalHandlers) {
        process.off(registeredSignal, handler);
      }
      logger.write("desktop app-server proxy stopped", { code, signal });
      resolveProxy(signal ? signalExitCode(signal) : (code ?? 1));
    });
  });
}

function printHelp() {
  process.stdout.write(`codex-desktop-proxy ${VERSION}

Internal CODEX_CLI_PATH shim for Codex Desktop. Non-app-server commands are
delegated unchanged. Desktop stdio app-server traffic is observed to recover
capacity failures and response-stream reconnections that fail or remain stalled.

Environment:
  CODEX_DESKTOP_REAL_CLI             Path to the bundled real Codex executable
  CODEX_DESKTOP_AUTO_DEBUG           Mirror recovery logs to stderr
  CODEX_CAPACITY_RETRY_MAX           Capacity retry limit
  CODEX_CAPACITY_RETRY_DELAY_MS      Initial capacity retry delay
  CODEX_CAPACITY_RETRY_MAX_DELAY_MS Maximum capacity retry delay
  CODEX_RECONNECT_STALL_MS           Reconnecting watchdog threshold
  CODEX_RECONNECT_RECOVERY_MAX       Reconnecting continuation limit
`);
}

async function runTransportSelfTest() {
  const logger = { write() {} };
  const child = { stdin: new PassThrough() };
  const rpc = new StdioRpcClient(child, logger);
  const controller = new CapacityRetryController({
    rpc,
    logger,
    retryMax: 12,
    retryDelayMs: 0,
    retryMaxDelayMs: 0,
    reconnectStallMs: 1,
    reconnectRecoveryMax: 3,
    sleeper: async () => {},
  });
  const requestObserver = new DesktopRequestObserver(controller);
  const forwardedClientMessages = [];
  const forwardedServerMessages = [];
  const proxyRequests = [];
  let outboundBuffer = "";

  const serverTransform = new JsonLineTransform(
    (line) => {
      const message = parseLine(line, logger, "self-test-server-to-client");
      if (!message) return line;
      if (rpc.consume(message)) return null;
      requestObserver.observeServerMessage(message);
      if (typeof message.method === "string" && message.id === undefined) {
        controller.handleNotification(message);
      }
      return line;
    },
    logger,
    "self-test-server-to-client",
  );
  const clientTransform = new JsonLineTransform(
    (line) => {
      const message = parseLine(line, logger, "self-test-client-to-server");
      if (message) requestObserver.observeClientMessage(message);
      return line;
    },
    logger,
    "self-test-client-to-server",
  );
  const deliverServer = (message) => {
    serverTransform.write(`${JSON.stringify(message)}\n`);
  };

  serverTransform.on("data", (chunk) => {
    const lines = chunk.toString("utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) forwardedServerMessages.push(JSON.parse(line));
  });
  child.stdin.on("data", (chunk) => {
    outboundBuffer += chunk.toString("utf8");
    let newlineIndex = outboundBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = outboundBuffer.slice(0, newlineIndex);
      outboundBuffer = outboundBuffer.slice(newlineIndex + 1);
      const message = JSON.parse(line);
      forwardedClientMessages.push(message);
      if (
        typeof message.id === "string" &&
        message.id.startsWith(rpc.idPrefix)
      ) {
        proxyRequests.push(message);
        if (message.method === "turn/interrupt") {
          deliverServer({ id: message.id, result: {} });
          deliverServer({
            method: "turn/completed",
            params: {
              threadId: message.params.threadId,
              turn: { id: message.params.turnId, status: "interrupted" },
            },
          });
        } else if (message.method === "thread/resume") {
          deliverServer({
            id: message.id,
            result: {
              reasoningEffort:
                message.params.threadId === "thread-capacity" ? "medium" : "xhigh",
            },
          });
        } else if (message.method === "turn/start") {
          deliverServer({
            id: message.id,
            result: { turn: { id: `recovered-${proxyRequests.length}` } },
          });
        }
      }
      newlineIndex = outboundBuffer.indexOf("\n");
    }
  });
  clientTransform.pipe(child.stdin);

  clientTransform.write(
    `${JSON.stringify({ method: "initialize", id: "desktop-init", params: {} })}\n`,
  );
  deliverServer({ id: "desktop-init", result: { userAgent: "self-test" } });
  deliverServer({ id: `${rpc.idPrefix}late`, result: {} });

  controller.observeThreadEffort("thread-reconnect", "xhigh");
  deliverServer({
    method: "turn/started",
    params: {
      threadId: "thread-reconnect",
      turn: { id: "turn-reconnect" },
    },
  });
  deliverServer({
    method: "error",
    params: {
      threadId: "thread-reconnect",
      turnId: "turn-reconnect",
      willRetry: true,
      error: {
        message: "stream disconnected - retrying sampling request",
        codexErrorInfo: { responseStreamDisconnected: {} },
      },
    },
  });
  await controller.drain();

  controller.observeThreadEffort("thread-capacity", "medium");
  deliverServer({
    method: "turn/started",
    params: {
      threadId: "thread-capacity",
      turn: { id: "turn-capacity" },
    },
  });
  deliverServer({
    method: "error",
    params: {
      threadId: "thread-capacity",
      turnId: "turn-capacity",
      willRetry: false,
      error: { codexErrorInfo: "serverOverloaded" },
    },
  });
  deliverServer({
    method: "turn/completed",
    params: {
      threadId: "thread-capacity",
      turn: { id: "turn-capacity", status: "failed" },
    },
  });
  await controller.drain();
  if (controller.threads.get("thread-capacity")?.retries !== 1) {
    throw new Error("Desktop proxy transport self-test did not record a retry");
  }
  clientTransform.write(
    `${JSON.stringify({
      method: "turn/start",
      id: "desktop-manual-turn",
      params: { threadId: "thread-capacity", input: [] },
    })}\n`,
  );
  if (controller.threads.get("thread-capacity")?.retries !== 0) {
    throw new Error("Desktop manual turn did not reset the retry counter");
  }

  const proxyMethods = proxyRequests.map((message) => message.method);
  const expectedMethods = [
    "turn/interrupt",
    "thread/resume",
    "turn/start",
    "thread/resume",
    "turn/start",
  ];
  if (JSON.stringify(proxyMethods) !== JSON.stringify(expectedMethods)) {
    throw new Error(
      `Desktop proxy transport self-test emitted ${JSON.stringify(proxyMethods)}`,
    );
  }
  const reconnectStart = proxyRequests.find(
    (message) =>
      message.method === "turn/start" &&
      message.params.threadId === "thread-reconnect",
  );
  if (!reconnectStart || Object.hasOwn(reconnectStart.params, "effort")) {
    throw new Error("Reconnect recovery did not preserve the current effort");
  }
  const capacityStart = proxyRequests.find(
    (message) =>
      message.method === "turn/start" &&
      message.params.threadId === "thread-capacity",
  );
  if (capacityStart?.params.effort !== "xhigh") {
    throw new Error("Capacity recovery did not toggle medium to xhigh");
  }
  if (
    forwardedClientMessages[0]?.id !== "desktop-init" ||
    !forwardedServerMessages.some((message) => message.id === "desktop-init")
  ) {
    throw new Error("Ordinary Desktop JSON-RPC traffic was not forwarded");
  }
  if (
    forwardedServerMessages.some(
      (message) =>
        typeof message.id === "string" && message.id.startsWith(rpc.idPrefix),
    )
  ) {
    throw new Error("Proxy-owned JSON-RPC responses leaked to Desktop");
  }

  controller.stop();
  rpc.close();
  clientTransform.end();
  serverTransform.end();
}

async function runSelfTest() {
  const desktopInvocation = [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--analytics-default-enabled",
  ];
  if (!shouldProxyAppServer(desktopInvocation)) {
    throw new Error("Desktop proxy self-test failed: app-server was not intercepted");
  }
  if (shouldProxyAppServer(["app-server", "--help"])) {
    throw new Error("Desktop proxy self-test failed: help must be delegated");
  }
  if (shouldProxyAppServer(["app-server", "daemon", "version"])) {
    throw new Error("Desktop proxy self-test failed: daemon must be delegated");
  }
  await runTransportSelfTest();
  process.stdout.write("codex-desktop-proxy self-test: ok\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--desktop-auto-help") {
    printHelp();
    return 0;
  }
  if (args.length === 1 && args[0] === "--desktop-auto-self-test") {
    await runSelfTest();
    return 0;
  }

  const realCodex = findRealCodex(process.argv[1]);
  if (!shouldProxyAppServer(args)) return delegate(realCodex, args);
  const logger = createLogger();
  return proxyAppServer(realCodex, args, logger);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[codex-desktop-auto] ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}

export { JsonLineTransform, StdioRpcClient, shouldProxyAppServer };
