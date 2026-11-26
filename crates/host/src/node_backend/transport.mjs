import { createConnection as connectPluginTransport } from "node:net";

const PLUGIN_TRANSPORT_MAX_FRAME = 256 * 1024;
const PLUGIN_TRANSPORT_MAX_READ = 16 * 1024;
const PLUGIN_TRANSPORT_MAX_WRITE = 128 * 1024;
const PLUGIN_TRANSPORT_MAX_WAIT = 2_147_483_647;
const PLUGIN_TRANSPORT_OPEN_MS = 4_000;
const PLUGIN_TRANSPORT_CLOSE_MS = 4_000;

function pluginTransportShape(frame, fields) {
  return (
    frame !== null &&
    typeof frame === "object" &&
    !Array.isArray(frame) &&
    Object.keys(frame).length === fields.length &&
    fields.every((field) => Object.hasOwn(frame, field))
  );
}

function rfc2217OpenFailure(error) {
  try {
    if (!(error instanceof Error)) return undefined;
    const ownValue = (key) =>
      Object.getOwnPropertyDescriptor(error, key)?.value;
    if (ownValue("name") !== "Rfc2217NegotiationError") return undefined;
    const reason = ownValue("reason");
    const field = ownValue("field");
    if (
      !["refused", "different_value", "timeout", "disconnected"].includes(
        reason,
      ) ||
      typeof field !== "string" ||
      !/^[A-Za-z]{1,12}$/.test(field)
    )
      return undefined;
    const hex = (key) => {
      const value = ownValue(key);
      return typeof value === "string" && /^(?:[0-9a-f]{2}){1,4}$/.test(value)
        ? value
        : undefined;
    };
    return {
      reason,
      field,
      requestedHex: hex("requestedHex"),
      replyHex: hex("replyHex"),
    };
  } catch {
    // 插件抛出的非标准对象不会影响统一的失败与清理流程。
    return undefined;
  }
}

function pluginTransportInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

async function* pluginTransportFrames(socket) {
  const header = Buffer.alloc(4);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let headerUsed = 0;
  let body = null;
  let bodyUsed = 0;
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    let offset = 0;
    while (offset < chunk.length) {
      if (body === null) {
        const count = Math.min(4 - headerUsed, chunk.length - offset);
        chunk.copy(header, headerUsed, offset, offset + count);
        offset += count;
        headerUsed += count;
        if (headerUsed !== 4) continue;
        const size = header.readUInt32BE();
        if (!pluginTransportInteger(size, 1, PLUGIN_TRANSPORT_MAX_FRAME)) {
          throw new Error("Invalid plugin transport frame length");
        }
        body = Buffer.alloc(size);
        headerUsed = 0;
      }
      const count = Math.min(body.length - bodyUsed, chunk.length - offset);
      chunk.copy(body, bodyUsed, offset, offset + count);
      offset += count;
      bodyUsed += count;
      if (bodyUsed === body.length) {
        const frame = JSON.parse(utf8.decode(body));
        body = null;
        bodyUsed = 0;
        yield frame;
      }
    }
  }
  if (headerUsed !== 0 || body !== null) {
    throw new Error("Truncated plugin transport frame");
  }
}

function nextPluginTransportFrame(frames, signal) {
  if (signal.aborted) return Promise.resolve({ done: true });
  return new Promise((resolve, reject) => {
    const stopped = () => resolve({ done: true });
    signal.addEventListener("abort", stopped, { once: true });
    frames.next().then(
      (frame) => {
        signal.removeEventListener("abort", stopped);
        resolve(frame);
      },
      (error) => {
        signal.removeEventListener("abort", stopped);
        reject(error);
      },
    );
  });
}

function sendPluginTransportFrame(socket, frame) {
  const body = Buffer.from(JSON.stringify(frame));
  const size = body.length + 4;
  if (
    body.length === 0 ||
    body.length > PLUGIN_TRANSPORT_MAX_FRAME ||
    socket.writableLength + size > 2 * (PLUGIN_TRANSPORT_MAX_FRAME + 4) ||
    socket.destroyed ||
    socket.writableEnded
  ) {
    return Promise.reject(new Error("Plugin transport output unavailable"));
  }
  const packet = Buffer.alloc(size);
  packet.writeUInt32BE(body.length);
  body.copy(packet, 4);
  return new Promise((resolve, reject) => {
    socket.write(packet, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function decodePluginTransportWrite(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4 * Math.ceil(PLUGIN_TRANSPORT_MAX_WRITE / 3)
  ) {
    throw new Error("Invalid plugin transport write bytes");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    !pluginTransportInteger(bytes.length, 1, PLUGIN_TRANSPORT_MAX_WRITE) ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("Invalid plugin transport write bytes");
  }
  return bytes;
}

function waitForPluginTransportCleanup(finished) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Plugin transport cleanup timed out")),
      PLUGIN_TRANSPORT_CLOSE_MS,
    );
    timeout.unref();
    finished.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function createPluginTransportLane({
  address,
  credential,
  params,
  open,
}) {
  const endpoint =
    typeof address === "string" &&
    /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(address);
  const port = endpoint ? Number(endpoint[1]) : 0;
  if (
    !pluginTransportInteger(port, 1, 65_535) ||
    endpoint[0] !== address ||
    typeof credential !== "string" ||
    credential.length !== 43 ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential) ||
    typeof open !== "function"
  ) {
    throw new Error("Invalid plugin transport offer");
  }

  const lifetime = new AbortController();
  const socket = connectPluginTransport({ host: "127.0.0.1", port });
  socket.on("error", () => lifetime.abort());
  const socketClosed = new Promise((resolve) => {
    socket.once("close", () => {
      lifetime.abort();
      resolve();
    });
  });
  const frames = pluginTransportFrames(socket);
  const active = { read: null, write: null, set_line: null };
  let lastId = 0;
  let activated = false;
  let requestedStop = false;
  let connection;
  let readMessage;
  let lineControls;

  function disconnect() {
    lifetime.abort();
    socket.destroy();
  }

  function dispatch(frame) {
    const reading = frame?.kind === "read";
    const control = frame?.kind === "set_line";
    const fields = reading
      ? ["kind", "id", "waitMs", "maxBytes"]
      : control
        ? ["kind", "id", "waitMs", "line", "value"]
        : ["kind", "id", "waitMs", "bytes"];
    if (
      (!reading && !control && frame?.kind !== "write") ||
      !pluginTransportShape(frame, fields) ||
      !pluginTransportInteger(frame.id, lastId + 1, Number.MAX_SAFE_INTEGER) ||
      !pluginTransportInteger(frame.waitMs, 0, PLUGIN_TRANSPORT_MAX_WAIT) ||
      active[frame.kind] !== null ||
      (reading &&
        !pluginTransportInteger(
          frame.maxBytes,
          1,
          readMessage ? PLUGIN_TRANSPORT_MAX_WRITE : PLUGIN_TRANSPORT_MAX_READ,
        )) ||
      (control &&
        ((frame.line !== "dtr" && frame.line !== "rts") ||
          typeof frame.value !== "boolean" ||
          lineControls?.[frame.line] !== true))
    ) {
      throw new Error("Invalid plugin transport request");
    }

    const bytes =
      reading || control ? null : decodePluginTransportWrite(frame.bytes);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const { id, kind, maxBytes, waitMs } = frame;
    lastId = id;
    const operation = { id, controller, finished: null };
    active[kind] = operation;
    operation.finished = Promise.resolve()
      .then(async () => {
        let reply;
        try {
          signal.throwIfAborted();
          if (reading && readMessage) {
            const value = await readMessage({ maxBytes, waitMs, signal });
            if (value === undefined || value === null) {
              reply = { kind: "read", id, bytes: "", eof: value === null };
            } else {
              if (
                !pluginTransportShape(value, ["bytes", "messageType"]) ||
                !(value.bytes instanceof Uint8Array) ||
                value.bytes.byteLength > maxBytes ||
                !["binary", "text", "datagram"].includes(value.messageType)
              ) {
                throw new Error("Invalid plugin transport message");
              }
              reply = {
                kind: "message",
                id,
                messageType: value.messageType,
                bytes: Buffer.from(value.bytes).toString("base64"),
              };
            }
          } else if (reading) {
            const value = await connection.read({ maxBytes, waitMs, signal });
            if (
              value !== null &&
              (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
            ) {
              throw new Error("Invalid plugin transport read result");
            }
            reply = {
              kind: "read",
              id,
              bytes:
                value === null ? "" : Buffer.from(value).toString("base64"),
              eof: value === null,
            };
          } else if (control) {
            const { line, value } = frame;
            const result = await lineControls.set({
              line,
              value,
              waitMs,
              signal,
            });
            if (
              pluginTransportShape(result, ["kind", "actual"]) &&
              result.kind === "confirmed" &&
              typeof result.actual === "boolean"
            ) {
              reply = { kind: "line", id, actual: result.actual };
            } else if (
              pluginTransportShape(result, ["kind"]) &&
              result.kind === "not_applied"
            ) {
              reply = { kind: "line", id };
            } else {
              throw new Error("Invalid plugin line response");
            }
          } else {
            const accepted = await connection.write({ bytes, waitMs, signal });
            if (
              !pluginTransportInteger(accepted, 0, bytes.length) ||
              (readMessage && accepted !== 0 && accepted !== bytes.length)
            ) {
              throw new Error("Invalid plugin transport write result");
            }
            reply = { kind: "written", id, accepted };
          }
        } catch {
          reply = { kind: "error", id };
        }
        // 对端收到回执即可提交同类请求，写入队列另有独立字节上限。
        active[kind] = null;
        if (!socket.destroyed) await sendPluginTransportFrame(socket, reply);
      })
      .catch(disconnect);
  }

  async function finishSocket(graceful) {
    if (!graceful || socket.destroyed || socket.writableEnded) {
      socket.destroy();
      await socketClosed;
      return;
    }
    socket.end();
    const timeout = setTimeout(() => socket.destroy(), 1_000);
    timeout.unref();
    try {
      await socketClosed;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function run() {
    let opening = false;
    let closeRequested = false;
    let openingFailed = false;
    let negotiation;
    let providerReturned = false;
    let cleanupFailed;
    const openDeadline = setTimeout(disconnect, PLUGIN_TRANSPORT_OPEN_MS);
    openDeadline.unref();
    try {
      await sendPluginTransportFrame(socket, { kind: "hello", credential });
      const { value: start } = await nextPluginTransportFrame(
        frames,
        lifetime.signal,
      );
      if (!pluginTransportShape(start, ["kind"]) || start.kind !== "start") {
        throw new Error("Invalid plugin transport start");
      }
      lifetime.signal.throwIfAborted();

      opening = true;
      connection = await open({ params, signal: lifetime.signal });
      providerReturned = true;
      if (
        !connection ||
        (typeof connection.read === "function") ===
          (typeof connection.readMessage === "function") ||
        typeof connection.write !== "function" ||
        typeof connection.close !== "function"
      ) {
        throw new Error("Invalid plugin transport connection");
      }
      lifetime.signal.throwIfAborted();
      readMessage =
        typeof connection.readMessage === "function"
          ? connection.readMessage.bind(connection)
          : undefined;
      const offeredLines = connection.lineControls;
      if (offeredLines !== undefined) {
        if (
          readMessage ||
          !offeredLines ||
          typeof offeredLines.dtr !== "boolean" ||
          typeof offeredLines.rts !== "boolean" ||
          typeof offeredLines.set !== "function"
        ) {
          throw new Error("Invalid plugin transport line capabilities");
        }
        lineControls = {
          dtr: offeredLines.dtr,
          rts: offeredLines.rts,
          set: offeredLines.set.bind(offeredLines),
        };
      }
      const opened = sendPluginTransportFrame(socket, {
        kind: "opened",
        semantics: readMessage ? "message" : undefined,
        lineControls: lineControls && {
          dtr: lineControls.dtr,
          rts: lineControls.rts,
        },
      });
      activated = true;
      await opened;
      opening = false;
      clearTimeout(openDeadline);

      while (!lifetime.signal.aborted) {
        const { done, value: frame } = await nextPluginTransportFrame(
          frames,
          lifetime.signal,
        );
        if (done || lifetime.signal.aborted) break;
        if (pluginTransportShape(frame, ["kind"]) && frame.kind === "close") {
          closeRequested = true;
          break;
        }
        if (
          pluginTransportShape(frame, ["kind", "id"]) &&
          frame.kind === "cancel" &&
          pluginTransportInteger(frame.id, 1, lastId)
        ) {
          for (const operation of Object.values(active)) {
            if (operation?.id === frame.id) operation.controller.abort();
          }
          continue;
        }
        dispatch(frame);
      }
    } catch (error) {
      openingFailed =
        opening && !activated && !lifetime.signal.aborted && !socket.destroyed;
      if (openingFailed) negotiation = rfc2217OpenFailure(error);
      else disconnect();
    } finally {
      clearTimeout(openDeadline);
      lifetime.abort();
      const graceful = activated && (closeRequested || requestedStop);
      if (!graceful && !openingFailed) socket.destroy();

      // 截止时立即断开私有通道。后台继续持有实际清理责任与晚退出结果。
      const closeDeadline = setTimeout(
        () => socket.destroy(),
        PLUGIN_TRANSPORT_CLOSE_MS,
      );
      closeDeadline.unref();
      try {
        const closing = Promise.resolve().then(() =>
          providerReturned ? connection.close() : undefined,
        );
        const pending = Object.values(active).flatMap((operation) =>
          operation === null ? [] : [operation.finished],
        );
        const results = await Promise.allSettled([closing, ...pending]);
        cleanupFailed = results.some(({ status }) => status === "rejected");
        if (!cleanupFailed) {
          if (graceful && !socket.destroyed) {
            await sendPluginTransportFrame(socket, { kind: "closed" }).catch(
              disconnect,
            );
          } else if (openingFailed && !socket.destroyed) {
            await sendPluginTransportFrame(socket, {
              kind: "error",
              negotiation,
            }).catch(disconnect);
          }
          await finishSocket((graceful || openingFailed) && !socket.destroyed);
        }
      } finally {
        clearTimeout(closeDeadline);
        socket.destroy();
        await socketClosed;
        await frames.return();
      }
    }
    if (cleanupFailed) throw new Error("Plugin transport cleanup failed");
  }

  const finished = run();
  return {
    finished,
    stop() {
      requestedStop = true;
      if (activated) lifetime.abort();
      else disconnect();
      return waitForPluginTransportCleanup(finished);
    },
  };
}
