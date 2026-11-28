import { Session as ScriptInspectorSession } from "node:inspector";

const SCRIPT_INSPECTOR_WAIT_MS = 4_000;
const SCRIPT_INSPECTOR_MAX_MESSAGE = 512 * 1024;
const SCRIPT_STACK_LIMIT = 12;
const SCRIPT_VARIABLE_LIMIT = 24;
const SCRIPT_SCOPE_TYPES = new Set([
  "local",
  "block",
  "closure",
  "catch",
  "script",
  "module",
]);
const SCRIPT_DEBUG_COMMANDS = new Map([
  ["continue", "Debugger.resume"],
  ["stepOver", "Debugger.stepOver"],
  ["stepInto", "Debugger.stepInto"],
  ["stepOut", "Debugger.stepOut"],
]);

export function confirmedScriptDebugUrl(sourceSha256) {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256))
    throw scriptDebuggerError(
      "INVALID_ARGUMENT",
      "Invalid script source digest",
    );
  return "serial-workbench-script:" + sourceSha256 + ".mjs";
}

function scriptDebuggerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function scriptDebuggerDeadline(promise) {
  let timer;
  const elapsed = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          scriptDebuggerError(
            "SCRIPT_DEBUG_UNAVAILABLE",
            "The script debugger did not respond",
          ),
        ),
      SCRIPT_INSPECTOR_WAIT_MS,
    );
    timer.unref();
  });
  return Promise.race([promise, elapsed]).finally(() => clearTimeout(timer));
}

function scriptDebuggerText(value, limit) {
  return typeof value === "string" ? value.slice(0, limit).toWellFormed() : "";
}

function scriptDebuggerPreview(value) {
  if (!value) return { type: "unavailable", preview: "" };
  const { type, subtype, unserializableValue, description } = value;
  if (type === "string")
    return { type, preview: scriptDebuggerText(value.value, 160) };
  if (type === "number" || type === "boolean" || type === "bigint")
    return {
      type,
      preview: scriptDebuggerText(
        unserializableValue ?? String(value.value),
        64,
      ),
    };
  if (subtype === "null") return { type: "null", preview: "null" };
  if (type === "undefined") return { type, preview: "undefined" };
  if (type === "object" || type === "function" || type === "symbol")
    return { type, preview: scriptDebuggerText(description, 96) };
  return { type: "unavailable", preview: "" };
}

/** The supervisor owns one worker and issues only fixed, frame-scoped inspector commands. */
export class ConfirmedScriptDebugger {
  #root = new ScriptInspectorSession();
  #attached = Promise.withResolvers();
  #requests = new Map();
  #requestId = 0;
  #revision = 0;
  #sessionId;
  #scriptId;
  #snapshot;
  #pause;
  #busy = false;
  #stopping = false;
  #closed = false;
  #workerTitle;
  #sourceUrl;
  #publish;
  #failed;

  constructor(worker, name, sourceSha256, { publish, failed }) {
    // NodeWorker.workerId is allocated per inspector connection. The title
    // uses the immutable worker thread ID and the name chosen by the supervisor.
    this.#workerTitle = "[worker " + worker.threadId + "] " + name;
    this.#sourceUrl = confirmedScriptDebugUrl(sourceSha256);
    this.#publish = publish;
    this.#failed = failed;
    void this.#attached.promise.catch(() => {});
    this.#root.connect();
    this.#root.on("NodeWorker.attachedToWorker", ({ params }) => {
      const { sessionId, workerInfo } = params;
      if (workerInfo.title !== this.#workerTitle || this.#sessionId) {
        void this.#post("NodeWorker.detach", { sessionId }).catch(() => {});
        return;
      }
      this.#sessionId = sessionId;
      this.#attached.resolve();
    });
    this.#root.on("NodeWorker.detachedFromWorker", ({ params }) => {
      if (params.sessionId === this.#sessionId) {
        this.#sessionId = undefined;
        this.#rejectRequests();
      }
    });
    this.#root.on("NodeWorker.receivedMessageFromWorker", ({ params }) => {
      if (params.sessionId !== this.#sessionId) return;
      try {
        if (params.message.length > SCRIPT_INSPECTOR_MAX_MESSAGE)
          throw scriptDebuggerError(
            "SCRIPT_DEBUG_UNAVAILABLE",
            "The inspector reply exceeds its budget",
          );
        this.#receive(JSON.parse(params.message));
      } catch (failure) {
        this.#reportFailure(failure);
      }
    });
  }

  #post(method, params) {
    return new Promise((resolve, reject) => {
      this.#root.post(method, params, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }

  async #request(method, params = {}) {
    if (this.#closed || !this.#sessionId || this.#requests.size >= 8)
      throw scriptDebuggerError(
        "SCRIPT_DEBUG_UNAVAILABLE",
        "The script debugger is unavailable",
      );
    const id = ++this.#requestId;
    const reply = Promise.withResolvers();
    this.#requests.set(id, reply);
    // Worker exit can reject the reply before the outer inspector acknowledgement.
    void reply.promise.catch(() => {});
    try {
      await this.#post("NodeWorker.sendMessageToWorker", {
        sessionId: this.#sessionId,
        message: JSON.stringify({ id, method, params }),
      });
      return await scriptDebuggerDeadline(reply.promise);
    } finally {
      this.#requests.delete(id);
    }
  }

  #receive(message) {
    if (Number.isSafeInteger(message.id)) {
      const pending = this.#requests.get(message.id);
      if (message.error)
        pending?.reject(
          scriptDebuggerError(
            "SCRIPT_DEBUG_UNAVAILABLE",
            "The inspector rejected a script command",
          ),
        );
      else pending?.resolve(message.result);
    } else if (message.method === "Debugger.scriptParsed") {
      if (message.params.url === this.#sourceUrl)
        this.#scriptId ??= message.params.scriptId;
    } else if (message.method === "Debugger.paused") {
      void this.#paused(message.params.callFrames).catch((failure) =>
        this.#reportFailure(failure),
      );
    } else if (message.method === "Debugger.resumed") {
      this.#pause = undefined;
      this.#update("running");
    }
  }

  #reportFailure(failure) {
    if (!this.#closed && !this.#stopping) this.#failed(failure);
  }

  #update(phase, details = {}) {
    if (this.#closed || this.#stopping) return;
    this.#snapshot = { revision: String(++this.#revision), phase, ...details };
    this.#publish(this.#snapshot);
  }

  async #paused(callFrames) {
    if (this.#stopping) {
      this.terminatePaused();
      return;
    }
    if (
      !this.#scriptId ||
      callFrames[0]?.location.scriptId !== this.#scriptId
    ) {
      await this.#request("Debugger.resume");
      return;
    }
    const pause = {
      frames: callFrames
        .filter(({ location }) => location.scriptId === this.#scriptId)
        .slice(0, SCRIPT_STACK_LIMIT),
    };
    this.#pause = pause;
    await this.#inspectFrame(pause, 0);
  }

  async #inspectFrame(pause, selectedFrame) {
    const variables = [];
    const visited = new Set();
    for (const scope of pause.frames[selectedFrame].scopeChain) {
      if (
        variables.length >= SCRIPT_VARIABLE_LIMIT ||
        this.#pause !== pause ||
        this.#stopping
      )
        break;
      if (
        !SCRIPT_SCOPE_TYPES.has(scope.type) ||
        typeof scope.object.objectId !== "string"
      )
        continue;
      const { result } = await this.#request("Runtime.getProperties", {
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: false,
      });
      for (const descriptor of result) {
        if (variables.length >= SCRIPT_VARIABLE_LIMIT) break;
        if (!descriptor.name || visited.has(descriptor.name)) continue;
        visited.add(descriptor.name);
        variables.push({
          name: scriptDebuggerText(descriptor.name, 96),
          ...scriptDebuggerPreview(descriptor.value),
        });
      }
    }
    if (this.#pause !== pause) return;
    this.#update("paused", {
      frames: pause.frames.map(({ functionName, location }) => ({
        name: scriptDebuggerText(functionName, 96),
        line: location.lineNumber + 1,
        column: (location.columnNumber ?? 0) + 1,
      })),
      selectedFrame,
      variables,
    });
  }

  async start(breakpoints) {
    if (
      !Array.isArray(breakpoints) ||
      breakpoints.length < 1 ||
      breakpoints.length > 32 ||
      breakpoints.some(
        (line) => !Number.isSafeInteger(line) || line < 1 || line > 65_537,
      )
    )
      throw scriptDebuggerError(
        "INVALID_ARGUMENT",
        "Invalid script breakpoints",
      );
    await this.#post("NodeWorker.enable", { waitForDebuggerOnStart: false });
    await scriptDebuggerDeadline(this.#attached.promise);
    await this.#request("Debugger.enable", { maxScriptsCacheSize: 256 * 1024 });
    const pattern = this.#sourceUrl.replace(".", "\\.");
    await this.#request("Debugger.setBlackboxPatterns", {
      patterns: ["^(?!" + pattern + "$).*"],
    });
    for (const line of new Set(breakpoints))
      await this.#request("Debugger.setBreakpointByUrl", {
        lineNumber: line - 1,
        url: this.#sourceUrl,
      });
    this.#update("running");
  }

  async command({ action, revision, frame }) {
    const pause = this.#pause;
    if (
      !pause ||
      this.#stopping ||
      this.#snapshot?.phase !== "paused" ||
      revision !== this.#snapshot.revision
    )
      throw scriptDebuggerError(
        "REVISION_CONFLICT",
        "The script pause has changed",
      );
    if (this.#busy)
      throw scriptDebuggerError(
        "HOST_BUSY",
        "A script debug command is pending",
      );
    this.#busy = true;
    try {
      if (action === "inspectFrame") {
        if (!Number.isSafeInteger(frame) || !pause.frames[frame])
          throw scriptDebuggerError("INVALID_ARGUMENT", "Invalid script frame");
        await this.#inspectFrame(pause, frame);
      } else {
        const method = SCRIPT_DEBUG_COMMANDS.get(action);
        if (!method)
          throw scriptDebuggerError(
            "INVALID_ARGUMENT",
            "Invalid script debug command",
          );
        await this.#request(method);
      }
    } catch (failure) {
      if (failure?.code === "SCRIPT_DEBUG_UNAVAILABLE")
        this.#reportFailure(failure);
      throw failure;
    } finally {
      this.#busy = false;
    }
  }

  terminatePaused() {
    this.#stopping = true;
    this.#pause = undefined;
    this.#snapshot = undefined;
    // Worker.terminate() must already be requested. V8 can only receive its
    // termination interrupt once the paused debugger loop exits.
    if (this.#sessionId && !this.#closed)
      void this.#request("Debugger.resume", { terminateOnResume: true }).catch(
        () => {},
      );
  }

  #rejectRequests() {
    for (const reply of this.#requests.values())
      reply.reject(
        scriptDebuggerError(
          "SCRIPT_DEBUG_UNAVAILABLE",
          "The script debugger worker exited",
        ),
      );
    this.#requests.clear();
  }

  /** Called after the worker's actual exit, or before user code was released. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#pause = undefined;
    this.#snapshot = undefined;
    this.#attached.reject(
      scriptDebuggerError(
        "SCRIPT_DEBUG_UNAVAILABLE",
        "The script debugger closed",
      ),
    );
    this.#rejectRequests();
    this.#root.disconnect();
  }
}
