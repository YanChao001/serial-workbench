/// <reference lib="dom" />
import {
  ContractValidationError,
  parseViewDerivedPage,
  parseViewRawBatch,
  parseViewSession,
} from "@serial-workbench/contracts/view";
import type {
  DerivedReadResult,
  RawBatch,
  SessionSnapshot,
} from "@serial-workbench/contracts";

export type ViewLocale = "en" | "zh-CN";

export interface ReadOnlyView {
  readonly locale: ViewLocale;
  readonly dark: boolean;
  close(): void;
}

type ViewHandlers = {
  onSession(snapshot: SessionSnapshot): void;
  onLocale?(locale: ViewLocale): void;
  onError(error: Error): void;
};

export function connectReadOnlyView(
  handlers: ViewHandlers & {
    onBatch(batch: RawBatch): void | Promise<void>;
  },
): ReadOnlyView {
  let last: RawBatch["cursor"] | undefined;
  return connectView(handlers, async (data, session) => {
    const batch = parseViewRawBatch(data);
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

export function connectDerivedView(
  handlers: ViewHandlers & {
    onPage(
      page: DerivedReadResult,
      afterGap?: { previousPosition: string; skippedThrough: string },
    ): void | Promise<void>;
  },
): ReadOnlyView {
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
    const page = parseViewDerivedPage(data.reply);
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
  handlers: ViewHandlers,
  onPage: (data: unknown, session: SessionSnapshot) => Promise<string>,
): ReadOnlyView {
  const [frameId, language, scheme, capability] = window.location.hash
    .slice(1)
    .split(".");
  if (window.parent === window || !/^[A-Za-z0-9_-]{43}$/.test(frameId ?? ""))
    throw new ContractValidationError("Missing plugin page identity");
  const channel = new MessageChannel();
  const local = channel.port1;
  const onLocale = capability === "locale" ? handlers.onLocale : undefined;
  let locale: ViewLocale = language === "zh-CN" ? "zh-CN" : "en";
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
        session = parseViewSession(data);
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
    if (closed) return;
    if (
      onLocale &&
      data &&
      typeof data === "object" &&
      "kind" in data &&
      data.kind === "viewLocale"
    ) {
      if (
        !("locale" in data) ||
        (data.locale !== "en" && data.locale !== "zh-CN")
      ) {
        fail(new ContractValidationError("Invalid plugin view locale"));
        return;
      }
      if (locale !== data.locale) {
        locale = data.locale;
        try {
          onLocale(locale);
        } catch (error) {
          fail(error);
        }
      }
      return;
    }
    void receive(data).catch(fail);
  };
  local.onmessageerror = () => fail(new ContractValidationError());
  window.addEventListener("pagehide", close, { once: true });
  // READY 只转移空端口。可信壳核对实际 frame 与本次标识后才交付数据。
  window.parent.postMessage(
    onLocale ? { frameId, localeUpdates: true } : frameId,
    "*",
    [channel.port2],
  );
  return {
    get locale() {
      return locale;
    },
    dark: scheme === "dark",
    close,
  };
}
