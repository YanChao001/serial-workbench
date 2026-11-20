/// <reference lib="dom" />
import {
  ContractValidationError,
  parseReply,
  parseWireFrame,
} from "@serial-workbench/contracts";
import type {
  DerivedReadResult,
  RawBatch,
  SessionSnapshot,
} from "@serial-workbench/contracts";

export interface ReadOnlyView {
  readonly locale: "en" | "zh-CN";
  readonly dark: boolean;
  close(): void;
}

export function connectReadOnlyView(handlers: {
  onSession(snapshot: SessionSnapshot): void;
  onBatch(batch: RawBatch): void | Promise<void>;
  onError(error: Error): void;
}): ReadOnlyView {
  let last: RawBatch["cursor"] | undefined;
  return connectView(handlers, async (data, session) => {
    const { channel, body } = parseWireFrame(data);
    if (channel !== "raw" || body.type !== "rawBatch")
      throw new ContractValidationError("Invalid plugin view frame");
    const { batch } = body;
    if (
      last &&
      (batch.previousCursor.hostId !== last.hostId ||
        batch.previousCursor.instanceEpoch !== last.instanceEpoch ||
        batch.previousCursor.scopeId !== last.scopeId ||
        batch.previousCursor.position !== last.position)
    )
      throw new ContractValidationError("Plugin view cursor changed");
    for (const item of batch.items) {
      const source = item.kind === "source" ? item.event : item.gap;
      if (
        source.sessionId !== session.sessionId ||
        source.sessionEpoch !== session.sessionEpoch ||
        source.hostId !== batch.cursor.hostId ||
        source.instanceEpoch !== batch.cursor.instanceEpoch
      )
        throw new ContractValidationError("Plugin view session changed");
    }
    await handlers.onBatch(batch);
    last = batch.cursor;
    return last.position;
  });
}

export function connectDerivedView(handlers: {
  onSession(snapshot: SessionSnapshot): void;
  onPage(
    page: DerivedReadResult,
    afterGap?: { previousPosition: string; skippedThrough: string },
  ): void | Promise<void>;
  onError(error: Error): void;
}): ReadOnlyView {
  let next = "0";
  let stream:
    Pick<DerivedReadResult, "operationId" | "instanceEpoch"> | undefined;
  return connectView(handlers, async (data, session) => {
    if (
      !data ||
      typeof data !== "object" ||
      !("previousPosition" in data) ||
      data.previousPosition !== next ||
      !("after" in data) ||
      typeof data.after !== "string" ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(data.after) ||
      BigInt(data.after) < BigInt(next) ||
      !("reply" in data)
    )
      throw new ContractValidationError("Invalid derived view cursor");
    const reply = parseReply(data.reply);
    if (
      !reply.ok ||
      !("kind" in reply.result) ||
      reply.result.kind !== "stream_derived_read"
    )
      throw new ContractValidationError("Missing derived viewer page");
    const page = reply.result.value;
    if (
      stream &&
      (page.operationId !== stream.operationId ||
        page.instanceEpoch !== stream.instanceEpoch)
    )
      throw new ContractValidationError("Derived view operation changed");
    let position = BigInt(data.after);
    for (const sample of page.samples) {
      position++;
      if (
        BigInt(sample.position) !== position ||
        sample.provenance.sources.some(
          (source) =>
            source.sessionId !== session.sessionId ||
            source.sessionEpoch !== session.sessionEpoch,
        )
      )
        throw new ContractValidationError(
          "Invalid derived sample source or position",
        );
    }
    if (!page.samples.length || BigInt(page.nextPosition) !== position)
      throw new ContractValidationError("Derived view page did not advance");
    await handlers.onPage(
      page,
      data.after === next
        ? undefined
        : { previousPosition: next, skippedThrough: data.after },
    );
    stream = {
      operationId: page.operationId,
      instanceEpoch: page.instanceEpoch,
    };
    next = page.nextPosition;
    return next;
  });
}

function connectView(
  handlers: {
    onSession(snapshot: SessionSnapshot): void;
    onError(error: Error): void;
  },
  onPage: (data: unknown, session: SessionSnapshot) => Promise<string>,
): ReadOnlyView {
  const [frameId, language, scheme] = window.location.hash.slice(1).split(".");
  if (window.parent === window || !/^[A-Za-z0-9_-]{43}$/.test(frameId ?? ""))
    throw new ContractValidationError("Missing plugin page identity");
  const channel = new MessageChannel();
  const local = channel.port1;
  let session: SessionSnapshot | undefined;
  let handling = false;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    local.close();
    window.removeEventListener("pagehide", close);
  }
  function fail(error: unknown) {
    close();
    handlers.onError(
      error instanceof Error ? error : new ContractValidationError(),
    );
  }
  async function receive(data: unknown) {
    if (closed || handling)
      throw new ContractValidationError("Overlapping plugin view delivery");
    handling = true;
    try {
      if (!session) {
        const reply = parseReply(data);
        if (
          !reply.ok ||
          !("kind" in reply.result) ||
          reply.result.kind !== "session"
        )
          throw new ContractValidationError("Missing plugin session snapshot");
        session = reply.result.value;
        handlers.onSession(session);
        return;
      }
      const position = await onPage(data, session);
      if (!closed) local.postMessage(position);
    } finally {
      handling = false;
    }
  }

  local.onmessage = (event) => {
    const data: unknown = event.data;
    void receive(data).catch(fail);
  };
  local.onmessageerror = () => fail(new ContractValidationError());
  window.addEventListener("pagehide", close, { once: true });
  // READY 只转移空端口。可信壳核对实际 frame 与本次标识后才交付数据。
  window.parent.postMessage(frameId, "*", [channel.port2]);
  return {
    locale: language === "zh-CN" ? "zh-CN" : "en",
    dark: scheme === "dark",
    close,
  };
}
