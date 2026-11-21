import { Console } from "node:console";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { Worker } from "node:worker_threads";

// 控制 stdout 独占；插件常规日志走独立的有界 stderr 读者。
globalThis.console = new Console({
  stdout: process.stderr,
  stderr: process.stderr,
});
const expectedHostPid = Number(process.argv[1]);
if (
  !Number.isSafeInteger(expectedHostPid) ||
  expectedHostPid <= 0 ||
  expectedHostPid > 0xffff_ffff
)
  process.exit(1);
const processGroup =
  process.platform === "darwin" ? Number(process.argv[2]) : process.pid;
if (!Number.isSafeInteger(processGroup) || processGroup <= 1) process.exit(1);
// 控制通道永久结束时失败关闭；该监听在 register 等待期间也可执行。
function disconnected() {
  // Rust 为 Node 建立独立进程组；父死亡时一并结束普通派生子进程。
  if (process.platform !== "win32") {
    process.kill(-processGroup, "SIGKILL");
  }
  process.exit(1);
}
process.stdin.once("end", disconnected);
process.stdin.once("close", disconnected);
process.stdin.once("error", disconnected);
if (process.platform === "linux") {
  // 主线程忙循环不能阻止原Host父死亡观察；macOS的启动期及运行期由私有原生组负责。
  const guardian = new Worker(
    `
    const {workerData} = require('node:worker_threads');
    const processGroup = workerData.processGroup;
    ${disconnected.toString()}
    function check() { if (process.ppid !== workerData.parentPid) disconnected(); }
    check(); setInterval(check, 100);
  `,
    {
      eval: true,
      execArgv: [],
      workerData: { parentPid: expectedHostPid, processGroup },
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 16,
        maxYoungGenerationSizeMb: 4,
        stackSizeMb: 1,
      },
    },
  );
  guardian.stdout.pipe(process.stderr, { end: false });
  guardian.stderr.pipe(process.stderr, { end: false });
  guardian.on("error", disconnected);
  guardian.on("exit", disconnected);
  await new Promise((resolve, reject) => {
    guardian.once("online", resolve);
    guardian.once("error", reject);
  });
  guardian.unref();
}
const MAX_FRAME = 1_048_576;
// 仅Host私有信封容纳额外元数据，公开帧与Node结果的预算保持原值。
const MAX_HOST_COMMAND = MAX_FRAME + 4096;
const RAW_FLAG = 0x8000_0000;
const DERIVED_FLAG = 0x4000_0000;
// 插件可修改普通导出/原型；观测只调用启动时捕获的原生入口。
const NativeDate = Date;
const nativeDateIso = Function.prototype.call.bind(Date.prototype.toISOString);
const nativePromiseThen = Function.prototype.call.bind(Promise.prototype.then);
const nativeWorkerHeap =
  typeof Worker.prototype.getHeapStatistics === "function"
    ? Function.prototype.call.bind(Worker.prototype.getHeapStatistics)
    : undefined;
const nativeRss = process.memoryUsage.rss.bind(process.memoryUsage);
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U64_TEXT = String(MAX_U64);
const write = process.stdout.write.bind(process.stdout);
function emit(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME || process.stdout.writableLength > MAX_FRAME * 2)
    process.exit(1);
  writeFrame(body, 0);
}
function writeFrame(body, flag) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length + flag);
  write(Buffer.concat([header, body]));
}
const groups = [
  "actions",
  "queries",
  "transports",
  "parsers",
  "views",
  "themes",
  "configuration",
];
const packages = new Map();
const workers = new Set();
const invocations = new Map();
const taskScope = new AsyncLocalStorage();
const taskReplies = new Map();
const rawLane = {
  flag: RAW_FLAG,
  maxRequest: 8 * 1024,
  maxReply: 256 * 1024 + 4096,
  sequence: 0n,
  replies: new Map(),
};
const derivedLane = {
  flag: DERIVED_FLAG,
  maxRequest: 32 * 1024,
  maxReply: 8192,
  sequence: 0n,
  replies: new Map(),
};
const DATA_SLOTS = 4;
const rejectedBeforeAdmission = new WeakSet();
let requestSequence = 0n;
let peakWorkers = 0;
let heartbeatTaskCursor = 0;

function nativeU64(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function updateTaskMemory(task) {
  let measuredWorkers = 0;
  let used = 0n;
  let sampledAt;
  for (const state of task.workers) {
    const sample = state.memorySample;
    if (!sample) continue;
    measuredWorkers++;
    used += BigInt(sample.used);
    if (sampledAt === undefined || sample.sampledAt < sampledAt)
      sampledAt = sample.sampledAt;
  }
  // 没有新样本时保留最后事实；worker退出不把已测内存伪造成零。
  if (measuredWorkers > 0 && used <= MAX_U64)
    task.lastMemory = Object.freeze({
      sampledAt,
      measuredWorkers: String(measuredWorkers),
      v8HeapUsedBytes: String(used),
    });
}

function refreshWorkerSamples() {
  if (!nativeWorkerHeap) return;
  for (const state of workers) {
    const worker = state.worker;
    if (!worker || state.sampling) continue;
    state.sampling = true;
    try {
      // 每个实际worker最多一个原生统计请求；主线程不等待其完成。
      nativePromiseThen(
        nativeWorkerHeap(worker),
        (statistics) => {
          state.sampling = false;
          if (state.worker !== worker || !workers.has(state)) return;
          try {
            const used = nativeU64(statistics.used_heap_size);
            const sampledAt = nativeDateIso(new NativeDate());
            if (
              used === undefined ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sampledAt)
            )
              return;
            state.memorySample = Object.freeze({ used, sampledAt });
            if (state.task) updateTaskMemory(state.task);
          } catch {
            // 原生取样不可用只缺省观测，不影响业务或清理责任。
          }
        },
        () => {
          state.sampling = false;
        },
      );
    } catch {
      state.sampling = false;
    }
  }
}

function taskObservation(task) {
  if (!task.hostTask) return undefined;
  const observation = {};
  if (task.progress !== undefined) observation.progress = task.progress;
  if (task.peakWorkers > 0)
    observation.workerObservation = {
      liveWorkers: String(task.workers.size),
      peakWorkers: String(task.peakWorkers),
      ...(task.lastMemory === undefined ? {} : { lastMemory: task.lastMemory }),
    };
  return Object.keys(observation).length === 0 ? undefined : observation;
}

function heartbeatFrame() {
  refreshWorkerSamples();
  const sample = {
    liveWorkers: String(workers.size),
    peakWorkers: String(peakWorkers),
  };
  try {
    const rssBytes = nativeU64(nativeRss());
    if (rssBytes !== undefined) sample.rssBytes = rssBytes;
  } catch {
    // RSS是整个Node进程的一次原生读数，不按线程累计，也不伪造零。
  }
  const observed = [];
  for (const task of invocations.values()) {
    const observation = taskObservation(task);
    if (observation !== undefined)
      observed.push({ requestId: task.requestId, observation });
  }
  if (observed.length > 0) {
    sample.task = observed[heartbeatTaskCursor % observed.length];
    heartbeatTaskCursor = (heartbeatTaskCursor + 1) % observed.length;
  }
  const frame = { kind: "heartbeat", sample };
  // report预检保证可容纳；防御性缺省也不能令观测撑爆心跳结束共享Node。
  if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME) delete sample.task;
  return frame;
}

function checkTask(message, task) {
  task.controller.signal.throwIfAborted();
  if (task.admissionClosed || invocations.get(message.requestId) !== task)
    throw Object.assign(new Error("Parent handler has finished"), {
      code: "OPERATION_NOT_RUNNING",
    });
}

function progressError(code, message) {
  return Object.assign(new Error(message), { code });
}

function progressU64(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_U64_TEXT.length &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= MAX_U64
  );
}

function checkProgressEnvelope(progress) {
  const workerObservation = {
    liveWorkers: MAX_U64_TEXT,
    peakWorkers: MAX_U64_TEXT,
    lastMemory: {
      sampledAt: "9999-12-31T23:59:59.999Z",
      measuredWorkers: MAX_U64_TEXT,
      v8HeapUsedBytes: MAX_U64_TEXT,
    },
  };
  const observation = { progress, workerObservation };
  const envelopes = [
    {
      kind: "heartbeat",
      sample: {
        rssBytes: MAX_U64_TEXT,
        liveWorkers: MAX_U64_TEXT,
        peakWorkers: MAX_U64_TEXT,
        task: { requestId: MAX_U64_TEXT, observation },
      },
    },
    { kind: "action_failed", requestId: MAX_U64_TEXT, observation },
  ];
  if (
    envelopes.some(
      (frame) => Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME,
    )
  )
    throw progressError("LIMIT_EXCEEDED", "Progress exceeds its frame budget");
}

function taskProgress(message, task) {
  return Object.freeze({
    report(value) {
      checkTask(message, task);
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.hasOwn(value, "completed") ||
        !Object.hasOwn(value, "unit") ||
        Reflect.ownKeys(value).some(
          (key) => key !== "completed" && key !== "unit" && key !== "total",
        )
      )
        throw progressError("INVALID_ARGUMENT", "Invalid task progress");
      const completed = value.completed;
      const unit = value.unit;
      const hasTotal = Object.hasOwn(value, "total");
      const total = hasTotal ? value.total : undefined;
      if (
        !progressU64(completed) ||
        typeof unit !== "string" ||
        (hasTotal &&
          (!progressU64(total) || BigInt(completed) > BigInt(total))) ||
        (task.progress !== undefined &&
          (unit !== task.progress.unit ||
            hasTotal !== Object.hasOwn(task.progress, "total") ||
            total !== task.progress.total ||
            BigInt(completed) < BigInt(task.progress.completed)))
      )
        throw progressError("INVALID_ARGUMENT", "Invalid task progress");
      if (unit.length > MAX_FRAME)
        throw progressError(
          "LIMIT_EXCEEDED",
          "Progress exceeds its frame budget",
        );
      const progress = Object.freeze({
        completed,
        unit,
        ...(hasTotal ? { total } : {}),
      });
      checkProgressEnvelope(progress);
      checkTask(message, task);
      task.progress = progress;
    },
  });
}

function observedActionFrame(response, task) {
  const observation = taskObservation(task);
  if (observation === undefined) return response;
  const observed = { ...response, observation };
  // 遥测尽力附加；合法领域回执不能因观测占位变成失败或丢失正文。
  return Buffer.byteLength(JSON.stringify(observed)) <= MAX_FRAME
    ? observed
    : response;
}

function stopTaskWorkers(task, reason) {
  for (const worker of task.workers) {
    // 失败不释放实际责任；invoke仍等待finished，原Rust监督处理未退出的容器。
    void worker.stop(reason).catch(() => {});
  }
}

function beginTaskCleanup(task) {
  if (task.cleanupStarted) return;
  task.cleanupStarted = true;
  // 心跳可达不代表原生worker可退出；通知Rust以原停止期限监督实际清理。
  emit({ kind: "action_stopping", requestId: task.requestId });
}

function stopTask(task, interrupted = false) {
  task.admissionClosed = true;
  task.workerInterrupted ||= interrupted;
  if (interrupted) beginTaskCleanup(task);
  task.controller.abort();
  stopTaskWorkers(task, interrupted ? "fault" : "cancel");
}

function exchangeTask(message, task, kind, body) {
  if (taskReplies.size >= 8 || requestSequence === 18_446_744_073_709_551_615n)
    throw Object.assign(new Error("Task request capacity is full"), {
      code: "HOST_BUSY",
    });
  const requestId = String(++requestSequence);
  const frame = {
    kind,
    requestId,
    parentRequestId: message.requestId,
    ...body,
  };
  if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME)
    throw Object.assign(
      new Error("Task request exceeds the control frame budget"),
      { code: "LIMIT_EXCEEDED" },
    );
  return new Promise((resolve, reject) => {
    taskReplies.set(requestId, { resolve, reject, task });
    emit(frame);
  });
}

function taskOperations(message, task) {
  return Object.freeze({
    async get(selector) {
      checkTask(message, task);
      let encoded;
      try {
        encoded = JSON.stringify(selector);
      } catch {
        throw Object.assign(new Error("Invalid operation selector"), {
          code: "INVALID_ARGUMENT",
        });
      }
      if (typeof encoded !== "string")
        throw Object.assign(new Error("Invalid operation selector"), {
          code: "INVALID_ARGUMENT",
        });
      if (Buffer.byteLength(encoded) > MAX_FRAME)
        throw Object.assign(
          new Error("Operation selector exceeds its byte budget"),
          { code: "LIMIT_EXCEEDED" },
        );
      return exchangeTask(message, task, "operation_get", {
        parentOperationId: message.parentOperationId,
        taskContext: message.taskContext,
        params: JSON.parse(encoded),
      });
    },
  });
}

async function exchangeData(message, task, params, lane) {
  checkTask(message, task);
  if (lane.replies.size >= DATA_SLOTS)
    throw progressError("HOST_BUSY", "Task stream request capacity is full");
  let encoded;
  try {
    encoded = JSON.stringify(params);
  } catch {
    throw progressError("INVALID_ARGUMENT", "Invalid task stream parameters");
  }
  if (typeof encoded !== "string")
    throw progressError("INVALID_ARGUMENT", "Invalid task stream parameters");
  if (Buffer.byteLength(encoded) > lane.maxRequest)
    throw progressError("LIMIT_EXCEEDED", "Task stream frame budget exceeded");
  checkTask(message, task);
  if (lane.replies.size >= DATA_SLOTS || lane.sequence === MAX_U64)
    throw progressError("HOST_BUSY", "Task stream request capacity is full");
  const requestId = String(++lane.sequence);
  const body = Buffer.from(
    JSON.stringify({
      requestId,
      parentRequestId: message.requestId,
      parentOperationId: message.parentOperationId,
      taskContext: message.taskContext,
      params: JSON.parse(encoded),
    }),
  );
  if (body.length > lane.maxRequest)
    throw progressError("LIMIT_EXCEEDED", "Task stream frame budget exceeded");
  checkTask(message, task);
  return new Promise((resolve, reject) => {
    lane.replies.set(requestId, { resolve, reject, task, message });
    writeFrame(body, lane.flag);
  });
}

function taskStreams(message, task) {
  return Object.freeze({
    read(params) {
      return exchangeData(message, task, params, rawLane);
    },
    publishDerived(params) {
      return exchangeData(message, task, params, derivedLane);
    },
  });
}

function taskActions(message, task) {
  let nextKey = 1n;
  let serial = Promise.resolve();
  let unresolved;
  let queued = 0;
  let queuedBytes = 0;
  return Object.freeze({
    invokeChild(intent) {
      try {
        checkTask(message, task);
      } catch (error) {
        return Promise.reject(error);
      }
      if (queued >= 8)
        return Promise.reject(
          Object.assign(new Error("Child queue is full"), {
            code: "HOST_BUSY",
          }),
        );
      let encoded;
      try {
        encoded = JSON.stringify(intent);
      } catch {
        return Promise.reject(
          Object.assign(new Error("Invalid child intent"), {
            code: "INVALID_ARGUMENT",
          }),
        );
      }
      if (typeof encoded !== "string")
        return Promise.reject(
          Object.assign(new Error("Invalid child intent"), {
            code: "INVALID_ARGUMENT",
          }),
        );
      const bytes = Buffer.byteLength(encoded);
      if (bytes > MAX_FRAME)
        return Promise.reject(
          Object.assign(new Error("Child intent exceeds its byte budget"), {
            code: "LIMIT_EXCEEDED",
          }),
        );
      if (queuedBytes + bytes > MAX_FRAME * 2)
        return Promise.reject(
          Object.assign(new Error("Child queue byte budget is full"), {
            code: "HOST_BUSY",
          }),
        );
      const snapshot = JSON.parse(encoded);
      const allowed = [
        "actionId",
        "target",
        "params",
        "revealTarget",
        "expectedRevision",
        "leaseId",
      ];
      if (
        !snapshot ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot) ||
        Object.keys(snapshot).some((key) => !allowed.includes(key))
      )
        return Promise.reject(
          Object.assign(new Error("Invalid child intent"), {
            code: "INVALID_ARGUMENT",
          }),
        );
      queued++;
      queuedBytes += bytes;
      const run = serial.then(async () => {
        checkTask(message, task);
        if (nextKey > 18_446_744_073_709_551_615n)
          throw Object.assign(new Error("Child identity is exhausted"), {
            code: "LIMIT_EXCEEDED",
          });
        const call = {
          protocolVersion: message.call.protocolVersion,
          hostId: message.call.hostId,
          instanceEpoch: message.call.instanceEpoch,
          actorId: message.call.actorId,
          taskContext: message.taskContext,
          parentOperationId: message.parentOperationId,
          childKey: String(nextKey),
          actionId: snapshot.actionId,
          target: snapshot.target,
          params: snapshot.params,
          revealTarget: snapshot.revealTarget ?? message.call.revealTarget,
          ...(snapshot.expectedRevision === undefined
            ? {}
            : { expectedRevision: snapshot.expectedRevision }),
          ...(snapshot.leaseId === undefined
            ? {}
            : { leaseId: snapshot.leaseId }),
        };
        const identity = JSON.stringify(call);
        // 未确认的接纳只能同键同参重试，不能把晚结果变成另一次效果。
        if (unresolved !== undefined && unresolved !== identity)
          throw Object.assign(
            new Error("Previous child admission is unconfirmed"),
            { code: "REQUEST_CONFLICT" },
          );
        const wasUnconfirmed = unresolved !== undefined;
        const response = exchangeTask(message, task, "invoke_child", { call });
        unresolved = identity;
        let operation;
        try {
          operation = await response;
        } catch (error) {
          // 仅本次首次尝试在接纳前拒绝时允许复用该键；不能抹掉旧尝试的不确定性。
          if (!wasUnconfirmed && rejectedBeforeAdmission.has(error))
            unresolved = undefined;
          throw error;
        }
        unresolved = undefined;
        nextKey++;
        return operation;
      });
      const completed = run.finally(() => {
        queued--;
        queuedBytes -= bytes;
      });
      serial = completed.catch(() => {});
      return completed;
    },
  });
}
const moduleRoots = new Set();
// 只限制正常依赖解析；可信 Node 的系统权限仍由完整执行信任承担。
function confineModules(roots) {
  function rootFor(url) {
    if (!url?.startsWith("file:")) return undefined;
    let path;
    try {
      path = realpathSync.native(fileURLToPath(url));
    } catch {
      return undefined;
    }
    return [...roots].find((root) => {
      const inside = relative(root, path);
      return (
        inside === "" ||
        (inside !== ".." &&
          !inside.startsWith(`..${sep}`) &&
          !isAbsolute(inside))
      );
    });
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith("node:")) return resolved;
      const target = rootFor(resolved.url);
      const parent = rootFor(context.parentURL);
      if (!target || (parent && parent !== target))
        throw new Error("Dependency is outside the verified package");
      return resolved;
    },
  });
}
confineModules(moduleRoots);
// 同步钩子不随 worker 继承；每个 worker 在导入包入口前安装相同边界。
const workerBootstrap = `
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isAbsolute, relative, sep} from 'node:path';
import {realpathSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {workerData} from 'node:worker_threads';
${confineModules.toString()}
confineModules(new Set([realpathSync.native(workerData.root)]));
await import(pathToFileURL(workerData.entry).href);
`;
const workerBootstrapUrl = new URL(
  `data:text/javascript;base64,${Buffer.from(workerBootstrap).toString("base64")}`,
);
function selection() {
  return Object.fromEntries(groups.map((key) => [key, []]));
}
function registerHandler(
  owner,
  packageId,
  group,
  id,
  handler,
  category = group,
) {
  const handlers = owner[group];
  if (
    owner.closed ||
    !owner.registering ||
    typeof id !== "string" ||
    !id.startsWith(`${packageId}.`) ||
    typeof handler !== "function" ||
    handlers.has(id) ||
    handlers.size >= 10_000
  )
    throw new Error("Invalid contribution handler");
  handlers.set(id, handler);
  owner.contributes[category].push(id);
}
function resultFrame(kind, requestId, value) {
  const serialized = JSON.stringify(value);
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized) > MAX_FRAME
  )
    throw new Error("Invalid handler result");
  const response = { kind, requestId, value: JSON.parse(serialized) };
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_FRAME)
    throw new Error("Handler result exceeds the control frame");
  return response;
}
async function dispose(id) {
  const owner = packages.get(id);
  if (!owner) return;
  packages.delete(id);
  owner.closed = true;
  let failed = false;
  for (const task of owner.tasks) stopTask(task);
  for (const result of await Promise.allSettled(
    [...owner.transportLanes].map((lane) => lane.stop()),
  )) {
    if (result.status === "rejected") failed = true;
  }
  // 先结束执行任务，再调用插件清理；清理函数可以等待 worker.finished。
  for (const result of await Promise.allSettled(
    [...owner.workers].map((worker) => worker.terminate()),
  )) {
    if (result.status === "rejected") failed = true;
  }
  for (const result of await Promise.allSettled(
    [...owner.tasks].map((task) => task.finished),
  )) {
    if (result.status === "rejected") failed = true;
  }
  for (const cleanup of owner.cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Package cleanup failed");
}
async function activate(message) {
  if (packages.has(message.id)) throw new Error("Package already active");
  moduleRoots.add(realpathSync.native(message.root));
  const configurationKinds = new Map(
    Object.entries(message.configurationKinds ?? {}),
  );
  const owner = {
    closed: false,
    registering: true,
    cleanups: [],
    workers: new Set(),
    contributes: selection(),
    queries: new Map(),
    actions: new Map(),
    parsers: new Map(),
    transports: new Map(),
    transportLanes: new Set(),
    tasks: new Set(),
  };
  packages.set(message.id, owner);
  const context = Object.freeze({
    onDispose(cleanup) {
      if (
        owner.closed ||
        owner.cleanups.length >= 128 ||
        typeof cleanup !== "function"
      )
        throw new Error("Invalid cleanup");
      owner.cleanups.push(cleanup);
    },
    contributions: Object.freeze({
      register(selected) {
        if (
          owner.closed ||
          !owner.registering ||
          !selected ||
          typeof selected !== "object" ||
          Array.isArray(selected) ||
          Object.keys(selected).length !== groups.length
        )
          throw new Error("Invalid contribution selection");
        for (const key of groups) {
          if (
            !Array.isArray(selected[key]) ||
            owner.contributes[key].length + selected[key].length > 10_000 ||
            selected[key].some((id) => typeof id !== "string")
          )
            throw new Error("Invalid contribution selection");
          owner.contributes[key].push(...selected[key]);
        }
      },
    }),
    queries: Object.freeze({
      register(id, handler) {
        registerHandler(owner, message.id, "queries", id, handler);
      },
    }),
    actions: Object.freeze({
      register(id, handler) {
        registerHandler(owner, message.id, "actions", id, handler);
      },
    }),
    parsers: Object.freeze({
      register(id, handler) {
        registerHandler(owner, message.id, "parsers", id, handler);
      },
    }),
    configuration: Object.freeze({
      registerQuery(id, handler) {
        if (configurationKinds.get(id) !== "query")
          throw new Error("Configuration is not a declared query");
        registerHandler(
          owner,
          message.id,
          "queries",
          id,
          handler,
          "configuration",
        );
      },
      registerAction(id, handler) {
        if (configurationKinds.get(id) !== "action")
          throw new Error("Configuration is not a declared action");
        registerHandler(
          owner,
          message.id,
          "actions",
          id,
          handler,
          "configuration",
        );
      },
    }),
    transports: Object.freeze({
      register(id, open) {
        registerHandler(owner, message.id, "transports", id, open);
      },
    }),
    workers: Object.freeze({
      start(entry) {
        const task = taskScope.getStore();
        if (task) {
          // 继承结束任务的晚回调不能降格为包级worker，别包context不能借用本任务。
          task.controller.signal.throwIfAborted();
          if (task.owner !== owner || task.admissionClosed)
            throw Object.assign(new Error("Worker task is unavailable"), {
              code: "OPERATION_NOT_RUNNING",
            });
        }
        if (
          owner.closed ||
          owner.workers.size >= 8 ||
          workers.size >= 32 ||
          typeof entry !== "string" ||
          entry.length > 1024 ||
          entry.includes("\\") ||
          entry.includes("\0") ||
          entry
            .split("/")
            .some((part) => !part || part === "." || part === "..")
        )
          throw new Error("Invalid worker entry");
        const path = resolve(message.root, entry);
        const inside = relative(message.root, path);
        if (
          isAbsolute(inside) ||
          inside === ".." ||
          inside.startsWith(`..${sep}`)
        )
          throw new Error("Invalid worker entry");
        const state = {
          task,
          sampling: false,
          memorySample: undefined,
          expectedStop: undefined,
          stop: undefined,
          finished: undefined,
          worker: new Worker(workerBootstrapUrl, {
            execArgv: [],
            stdout: true,
            stderr: true,
            trackUnmanagedFds: true,
            workerData: { root: message.root, entry: path },
            resourceLimits: {
              maxOldGenerationSizeMb: 64,
              maxYoungGenerationSizeMb: 8,
              stackSizeMb: 4,
            },
          }),
        };
        // 工作者输出不能写入共享控制 stdout；stderr 由 Rust 独立限额读取。
        state.worker.stdout.pipe(process.stderr, { end: false });
        state.worker.stderr.pipe(process.stderr, { end: false });
        state.worker.on("error", () => {
          if (task) stopTask(task, true);
        });
        const finished = new Promise((resolve) =>
          state.worker.once("exit", (exitCode) => {
            if (task) updateTaskMemory(task);
            workers.delete(state);
            owner.workers.delete(handle);
            task?.workers.delete(state);
            state.worker = undefined;
            state.task = undefined;
            state.memorySample = undefined;
            if (task) updateTaskMemory(task);
            if (task && exitCode !== 0) {
              if (state.expectedStop === undefined) stopTask(task, true);
              else if (state.expectedStop === "cancel" && task.handlerReturned)
                task.cancelledPendingWorkers = true;
            }
            resolve(Object.freeze({ exitCode }));
          }),
        );
        state.finished = finished;
        state.stop = async (reason) => {
          state.expectedStop ??= reason;
          if (state.worker) await state.worker.terminate();
          return finished;
        };
        const terminate = () => state.stop("explicit");
        const handle = Object.freeze({ finished, terminate });
        workers.add(state);
        peakWorkers = Math.max(peakWorkers, workers.size);
        owner.workers.add(handle);
        task?.workers.add(state);
        if (task)
          task.peakWorkers = Math.max(task.peakWorkers, task.workers.size);
        return handle;
      },
    }),
  });
  try {
    const entry = pathToFileURL(message.entry);
    entry.searchParams.set("generation", message.requestId);
    const module = await import(entry.href);
    if (typeof module.register !== "function")
      throw new Error("Missing register");
    const cleanup = await module.register(context);
    if (typeof cleanup !== "function") throw new Error("Missing dispose");
    owner.cleanups.push(cleanup);
    if (owner.contributes.queries.some((id) => !owner.queries.has(id)))
      throw new Error("Selected query has no handler");
    if (owner.contributes.actions.some((id) => !owner.actions.has(id)))
      throw new Error("Selected action has no handler");
    if (owner.contributes.parsers.some((id) => !owner.parsers.has(id)))
      throw new Error("Selected parser has no handler");
    if (
      owner.contributes.configuration.some((id) => {
        const kind = configurationKinds.get(id);
        if (kind === "query") return !owner.queries.has(id);
        return kind !== "action" || !owner.actions.has(id);
      })
    )
      throw new Error("Selected configuration has no handler");
    if (owner.contributes.transports.some((id) => !owner.transports.has(id)))
      throw new Error("Selected transport has no provider");
    owner.registering = false;
    return owner.contributes;
  } catch (error) {
    await dispose(message.id);
    throw error;
  }
}
function invoke(message) {
  const owner = packages.get(message.id);
  const handler =
    owner?.actions.get(message.call.actionId) ??
    owner?.parsers.get(message.call.actionId);
  if (
    !owner ||
    owner.closed ||
    typeof handler !== "function" ||
    invocations.has(message.requestId) ||
    invocations.size >= 8
  )
    throw new Error("Action handler is unavailable");
  const task = {
    owner,
    requestId: message.requestId,
    hostTask: message.taskContext !== undefined,
    progress: undefined,
    peakWorkers: 0,
    lastMemory: undefined,
    controller: new AbortController(),
    finished: undefined,
    workers: new Set(),
    admissionClosed: false,
    handlerReturned: false,
    workerInterrupted: false,
    workerFaultConfirmed: false,
    cancelledPendingWorkers: false,
    cleanupStarted: false,
  };
  invocations.set(message.requestId, task);
  owner.tasks.add(task);
  task.finished = Promise.resolve().then(async () => {
    let response;
    try {
      task.controller.signal.throwIfAborted();
      const value = await taskScope.run(
        task,
        async () =>
          await handler(
            Object.freeze(message.call),
            Object.freeze({
              signal: task.controller.signal,
              ...(message.taskContext === undefined
                ? {}
                : {
                    taskContext: message.taskContext,
                    actions: taskActions(message, task),
                    operations: taskOperations(message, task),
                    streams: taskStreams(message, task),
                    progress: taskProgress(message, task),
                  }),
            }),
          ),
      );
      task.handlerReturned = true;
      task.admissionClosed = true;
      // 返回值归一化及序列化的用户getter不能逃出任务作用域或重新接纳工作。
      response = taskScope.run(task, () =>
        resultFrame("action_completed", message.requestId, value),
      );
      // worker已退出后由handler确认的领域结果，仍沿用真实晚成功规则。
      task.workerFaultConfirmed =
        task.workerInterrupted && task.workers.size === 0;
    } catch (error) {
      if (!task.controller.signal.aborted)
        console.error("Node action failed", error);
      response = {
        kind: task.controller.signal.aborted
          ? "action_cancelled"
          : "action_failed",
        requestId: message.requestId,
      };
    } finally {
      task.admissionClosed = true;
      if (response?.kind !== "action_completed" && task.workers.size > 0) {
        beginTaskCleanup(task);
        stopTaskWorkers(task, "cleanup");
      }
      // 早返回只是候选结果；仍持有invocation与名额，取消通道可停止剩余工作。
      await Promise.all([...task.workers].map((worker) => worker.finished));
      if (task.workerInterrupted && !task.workerFaultConfirmed)
        response = { kind: "action_interrupted", requestId: message.requestId };
      else if (task.cancelledPendingWorkers)
        response = { kind: "action_cancelled", requestId: message.requestId };
      invocations.delete(message.requestId);
      owner.tasks.delete(task);
    }
    emit(observedActionFrame(response, task));
  });
}
function valid(message) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    typeof message.requestId !== "string" ||
    !/^[1-9][0-9]*$/.test(message.requestId) ||
    BigInt(message.requestId) > 18_446_744_073_709_551_615n
  )
    return false;
  if (message.kind === "task_reply")
    return (
      Object.keys(message).length === 4 &&
      typeof message.beforeAdmission === "boolean" &&
      message.reply !== null &&
      typeof message.reply === "object" &&
      typeof message.reply.ok === "boolean"
    );
  if (message.kind === "activate") {
    const { configurationKinds } = message;
    return (
      Object.keys(message).length ===
        (configurationKinds === undefined ? 5 : 6) &&
      typeof message.id === "string" &&
      typeof message.entry === "string" &&
      typeof message.root === "string" &&
      (configurationKinds === undefined ||
        (configurationKinds !== null &&
          typeof configurationKinds === "object" &&
          !Array.isArray(configurationKinds) &&
          Object.values(configurationKinds).every(
            (kind) => kind === "query" || kind === "action",
          )))
    );
  }
  if (message.kind === "dispose")
    return Object.keys(message).length === 3 && typeof message.id === "string";
  if (message.kind === "query")
    return (
      Object.keys(message).length === 4 &&
      typeof message.id === "string" &&
      message.query !== null &&
      typeof message.query === "object" &&
      !Array.isArray(message.query) &&
      typeof message.query.actionId === "string"
    );
  if (message.kind === "invoke")
    return (
      Object.keys(message).length ===
        (Object.hasOwn(message, "taskContext") ? 6 : 4) &&
      (!Object.hasOwn(message, "taskContext") ||
        (typeof message.taskContext === "string" &&
          /^[A-Za-z0-9_-]{1,2048}$/.test(message.taskContext))) &&
      (!Object.hasOwn(message, "taskContext") ||
        typeof message.parentOperationId === "string") &&
      typeof message.id === "string" &&
      message.call !== null &&
      typeof message.call === "object" &&
      !Array.isArray(message.call) &&
      typeof message.call.actionId === "string"
    );
  if (message.kind === "open_transport")
    return (
      Object.keys(message).length === 7 &&
      typeof message.id === "string" &&
      typeof message.transportId === "string" &&
      typeof message.address === "string" &&
      typeof message.credential === "string" &&
      /^127[.]0[.]0[.]1:[1-9][0-9]{0,4}$/.test(message.address) &&
      /^[A-Za-z0-9_-]{43}$/.test(message.credential) &&
      message.params !== null &&
      typeof message.params === "object" &&
      !Array.isArray(message.params)
    );
  if (message.kind === "cancel_action")
    return Object.keys(message).length === 2;
  return message.kind === "shutdown" && Object.keys(message).length === 2;
}
emit({
  kind: "ready",
  probe: {
    version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    modulesAbi: process.versions.modules,
    nodeApiVersion: process.versions.napi,
    execPath: process.execPath,
  },
});
async function command(message) {
  try {
    if (message.kind === "activate")
      emit({
        kind: "registered",
        requestId: message.requestId,
        contributes: await activate(message),
      });
    else if (message.kind === "dispose") {
      await dispose(message.id);
      emit({ kind: "disposed", requestId: message.requestId });
    } else if (message.kind === "open_transport") {
      const owner = packages.get(message.id);
      const open = owner?.transports.get(message.transportId);
      if (
        !owner ||
        owner.closed ||
        owner.registering ||
        typeof open !== "function" ||
        owner.transportLanes.size >= 16
      )
        throw new Error("Transport provider unavailable");
      const lane = taskScope.run(undefined, () =>
        createPluginTransportLane({
          address: message.address,
          credential: message.credential,
          params: Object.freeze(message.params),
          open,
        }),
      );
      owner.transportLanes.add(lane);
      lane.finished.then(
        () => owner.transportLanes.delete(lane),
        () => process.exit(1),
      );
      emit({ kind: "transport_started", requestId: message.requestId });
    } else if (message.kind === "query") {
      const owner = packages.get(message.id);
      const handler = owner?.queries.get(message.query.actionId);
      if (!owner || owner.closed || typeof handler !== "function")
        throw new Error("Query handler is unavailable");
      const value = await handler(Object.freeze(message.query));
      emit(resultFrame("queried", message.requestId, value));
    } else {
      for (const id of packages.keys()) await dispose(id);
      emit({ kind: "stopped", requestId: message.requestId });
      clearInterval(heartbeat);
      // Rust 在收到真实清理收据后终止并回收整个自有执行容器。
    }
  } catch (error) {
    if (message.kind === "query") console.error("Node query failed", error);
    emit({
      kind: message.kind === "query" ? "query_failed" : "failed",
      requestId: message.requestId,
    });
  }
}
let commands = Promise.resolve();
let queued = 0;
function dispatch(message) {
  // 控制读取不等待业务Promise；查询、注册和dispose等待期间仍可取消实际任务。
  if (message.kind === "task_reply") {
    const pending = taskReplies.get(message.requestId);
    if (!pending) process.exit(1);
    taskReplies.delete(message.requestId);
    if (message.reply.ok)
      pending.resolve(Object.freeze(message.reply.result.operation));
    else {
      const error = Object.assign(
        new Error(message.reply.error.message),
        message.reply.error,
      );
      if (message.beforeAdmission) rejectedBeforeAdmission.add(error);
      pending.reject(error);
    }
    return;
  }
  if (message.kind === "cancel_action") {
    const task = invocations.get(message.requestId);
    if (task) stopTask(task);
    return;
  }
  if (message.kind === "invoke") {
    try {
      invoke(message);
    } catch (error) {
      console.error("Node action failed", error);
      emit({ kind: "action_failed", requestId: message.requestId });
    }
    return;
  }
  if (queued >= 8) process.exit(1);
  queued++;
  commands = commands
    .then(() => command(message))
    .finally(() => {
      queued--;
    });
  void commands.catch(() => process.exit(1));
}
function dispatchData(message, lane) {
  if (
    !message ||
    typeof message !== "object" ||
    Object.keys(message).length !== 2 ||
    !progressU64(message.requestId) ||
    !message.reply ||
    typeof message.reply.ok !== "boolean"
  )
    process.exit(1);
  const pending = lane.replies.get(message.requestId);
  if (!pending) process.exit(1);
  lane.replies.delete(message.requestId);
  try {
    checkTask(pending.message, pending.task);
    if (!message.reply.ok) {
      // 数据通道可能先收到 Host 的取消回执，再收到控制帧。先关闭任务准入并通知处理器。
      if (message.reply.error.code === "CANCELLED") stopTask(pending.task);
      throw Object.assign(
        new Error(message.reply.error.message),
        message.reply.error,
      );
    }
    const result = message.reply.result;
    if (!result) process.exit(1);
    const validResult =
      lane === rawLane
        ? Array.isArray(result.events) &&
          progressU64(result.nextEventSeq) &&
          typeof result.hasMore === "boolean"
        : result.operationId === pending.message.parentOperationId &&
          progressU64(result.position) &&
          result.position !== "0";
    if (!validResult) process.exit(1);
    pending.resolve(Object.freeze(result));
  } catch (error) {
    pending.reject(error);
  }
}
const heartbeat = setInterval(() => emit(heartbeatFrame()), 250);
let pending = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const tagged = pending.readUInt32LE(0);
    const tag = tagged - (tagged % DERIVED_FLAG);
    if (tag === RAW_FLAG + DERIVED_FLAG) process.exit(1);
    const lane =
      tag === RAW_FLAG
        ? rawLane
        : tag === DERIVED_FLAG
          ? derivedLane
          : undefined;
    const size = tagged - tag;
    if (size === 0 || size > (lane?.maxReply ?? MAX_HOST_COMMAND))
      process.exit(1);
    if (pending.length < size + 4) break;
    const message = JSON.parse(pending.subarray(4, size + 4).toString("utf8"));
    pending = pending.subarray(size + 4);
    if (lane) dispatchData(message, lane);
    else {
      if (!valid(message)) process.exit(1);
      dispatch(message);
    }
  }
}
clearInterval(heartbeat);
