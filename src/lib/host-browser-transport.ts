import {
  ContractValidationError,
  parseWireFrame,
  type IpcMessage,
  type Query,
  type RpcRequest,
  type StateScopeRef,
  type Target,
  type WireFrame,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import {
  bindHostConnection,
  type HostConnection,
  type WorkbenchHostTransport,
} from "./host-client";
import { abortError, waitForHost } from "./host-native-transport";
import { browserHostClientId } from "./browser-host-page";

const MAX_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT = 10_000;
const REQUEST_TIMEOUT = 30_000;
const connectionClosed = () =>
  new HostRequestError({
    code: "BROWSER_CONNECTION_CLOSED",
    message: "The connection to the local Host closed",
    retryable: false,
  });

type SocketChannel = "control" | "raw";
type PendingReply = {
  receive: (frame: WireFrame) => void;
  reject: (error: Error) => void;
};

class BrowserSocket {
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<string, PendingReply>();
  readonly events = new Map<string, (frame: WireFrame) => void>();
  private preparing = 0;
  private early: { subscriptionId: string; frame: WireFrame; size: number }[] =
    [];
  private earlyBytes = 0;
  readonly catalog = new Set<() => void>();
  readonly closed = this.lifetime.signal;

  get failure(): Error {
    const reason: unknown = this.closed.reason;
    return reason instanceof Error ? reason : connectionClosed();
  }

  private constructor(
    private readonly socket: WebSocket,
    readonly channel: SocketChannel,
  ) {
    socket.addEventListener("close", () => this.close());
    socket.addEventListener("error", () => this.close());
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (this.closed.aborted) return;
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > MAX_FRAME_BYTES
        )
          throw new ContractValidationError("Invalid Host WebSocket message");
        this.receive(parseWireFrame(JSON.parse(event.data)), event.data.length);
      } catch (error) {
        this.close(error instanceof Error ? error : connectionClosed());
      }
    });
  }

  static async open(endpoint: URL, channel: SocketChannel) {
    const socket = new WebSocket(endpoint);
    const connection = new BrowserSocket(socket, channel);
    const timer = setTimeout(() => connection.close(), HANDSHAKE_TIMEOUT);
    try {
      const opening = new Promise<void>((resolve) => {
        socket.addEventListener("open", () => resolve(), { once: true });
      });
      await waitForHost(opening, connection.closed);
      return connection;
    } catch {
      throw connectionClosed();
    } finally {
      clearTimeout(timer);
    }
  }

  private receive(frame: WireFrame, bytes: number) {
    const body = frame.body;
    if (
      (this.channel === "control" &&
        frame.channel === "state" &&
        (body.type === "delta" || body.type === "subscriptionEnded")) ||
      (this.channel === "raw" &&
        frame.channel === "raw" &&
        (body.type === "rawBatch" || body.type === "subscriptionEnded"))
    ) {
      // Raw batches carry the reader's frame ID, which differs from the RPC request ID.
      const subscriptionId =
        body.type === "rawBatch"
          ? body.batch.subscriptionId
          : body.subscriptionId;
      const listener = this.events.get(subscriptionId);
      if (listener) listener(frame);
      else if (this.preparing) {
        if (
          this.early.length >= 256 ||
          this.earlyBytes + bytes > 4 * MAX_FRAME_BYTES
        )
          throw new ContractValidationError("Host subscription setup overflow");
        this.early.push({ subscriptionId, frame, size: bytes });
        this.earlyBytes += bytes;
      }
      return;
    }
    if (frame.channel !== this.channel)
      throw new ContractValidationError("Unexpected Host channel");
    if (body.type === "catalogChanged" && this.channel === "control") {
      for (const notify of this.catalog) notify();
      return;
    }
    this.pending.get(frame.requestId)?.receive(frame);
  }

  beginSubscription() {
    this.preparing++;
    return () => {
      this.preparing--;
      if (this.preparing === 0) {
        this.early.length = 0;
        this.earlyBytes = 0;
      }
    };
  }

  finishSubscription(id: string, listener: (frame: WireFrame) => void) {
    this.events.set(id, listener);
    const ready: WireFrame[] = [];
    this.early = this.early.filter(({ subscriptionId, frame, size }) => {
      if (subscriptionId !== id) return true;
      this.earlyBytes -= size;
      ready.push(frame);
      return false;
    });
    for (const frame of ready) this.events.get(id)?.(frame);
  }

  exchange(
    body: IpcMessage,
    requestId: string = crypto.randomUUID(),
    timeout = REQUEST_TIMEOUT,
  ): Promise<IpcMessage> {
    if (this.closed.aborted) return Promise.reject(this.failure);
    if (this.pending.has(requestId))
      return Promise.reject(
        new ContractValidationError("Duplicate request ID"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeout);
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(requestId);
      };
      this.pending.set(requestId, {
        receive: ({ body }) => {
          finish();
          if (body.type === "error") reject(new HostRequestError(body.error));
          else resolve(body);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      try {
        this.socket.send(
          JSON.stringify({ requestId, channel: this.channel, body }),
        );
      } catch {
        this.close();
      }
    });
  }

  async request(request: RpcRequest) {
    const id =
      "requestId" in request.params ? request.params.requestId : undefined;
    const timeout =
      request.method === "browser.takeover" && request.params.kind === "request"
        ? 180_000
        : REQUEST_TIMEOUT;
    const body = await this.exchange({ type: "request", request }, id, timeout);
    if (body.type !== "reply")
      throw new ContractValidationError("Expected a Host RPC reply");
    return body.reply;
  }

  close(error: Error = connectionClosed()) {
    if (this.closed.aborted) return;
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(error);
    this.lifetime.abort(error);
    this.events.clear();
    this.catalog.clear();
    this.early.length = 0;
    this.earlyBytes = 0;
  }
}

type Subscription = {
  onFrame: (frame: WireFrame) => void;
  onError: (error: Error) => void;
};

async function subscribe(
  socket: BrowserSocket,
  query: Query,
  receiver: Subscription,
  signal?: AbortSignal,
) {
  if (socket.closed.aborted) throw socket.failure;
  if (signal?.aborted) throw abortError();
  let subscriptionId: string | undefined;
  let stopped = false;
  let ended = false;
  const detach = () => {
    if (subscriptionId) socket.events.delete(subscriptionId);
    signal?.removeEventListener("abort", stop);
    socket.closed.removeEventListener("abort", lost);
  };
  const release = (id: string) => {
    void socket
      .request({
        method: "subscription.close",
        params: {
          ...query,
          requestId: crypto.randomUUID(),
          actionId: "subscription.close",
          params: { subscriptionId: id },
        },
      })
      .then((reply) => {
        if (!reply.ok) throw new HostRequestError(reply.error);
      })
      .catch((error: unknown) => {
        // Closing the physical channel cleans up a subscription whose stop did not settle.
        if (!(error instanceof HostRequestError && error.code === "NOT_FOUND"))
          socket.close();
      });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    detach();
    if (subscriptionId && !ended && !socket.closed.aborted)
      release(subscriptionId);
  };
  const lost = () => {
    stop();
    receiver.onError(socket.failure);
  };
  const deliver = (frame: WireFrame) => {
    try {
      if (frame.body.type === "subscriptionEnded") {
        ended = true;
        stop();
      }
      receiver.onFrame(frame);
    } catch (error) {
      stop();
      receiver.onError(error instanceof Error ? error : connectionClosed());
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  socket.closed.addEventListener("abort", lost, { once: true });
  const finishSetup = socket.beginSubscription();
  const pending = (async () => {
    try {
      const reply = await socket.request({
        method:
          socket.channel === "raw" ? "stream.subscribe" : "state.subscribe",
        params: query,
      });
      if (!reply.ok) throw new HostRequestError(reply.error);
      const result = reply.result;
      subscriptionId =
        "subscriptionId" in result
          ? result.subscriptionId
          : "kind" in result &&
              (result.kind === "subscription" ||
                result.kind === "stream_subscribe")
            ? result.value.subscriptionId
            : undefined;
      if (!subscriptionId)
        throw new ContractValidationError("Expected a Host subscription");
      if (stopped) {
        if (!socket.closed.aborted) release(subscriptionId);
        throw abortError();
      }
      socket.finishSubscription(subscriptionId, deliver);
      return { subscriptionId, unsubscribe: stop };
    } catch (error) {
      stop();
      throw error;
    } finally {
      finishSetup();
    }
  })();
  return waitForHost(pending, signal);
}

export function browserReconnectCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function createBrowserHostConnection(
  credential: string,
  {
    expectedHostId,
    pairingCode,
  }: { expectedHostId?: string; pairingCode?: string } = {},
): Promise<
  HostConnection & { browser: NonNullable<HostConnection["browser"]> }
> {
  const clientId = browserHostClientId();
  if (!clientId) throw connectionClosed();
  const endpoint = new URL("/api/ws", location.href);
  endpoint.protocol = "ws:";
  const control = await BrowserSocket.open(endpoint, "control");
  try {
    const authenticated = await control.exchange(
      pairingCode === undefined
        ? { type: "authenticate", clientId, credential }
        : {
            type: "browserPair",
            clientId,
            pairingCode,
            reconnectCredential: credential,
          },
      undefined,
      HANDSHAKE_TIMEOUT,
    );
    if (
      authenticated.type !== "authenticated" ||
      authenticated.credential !== undefined
    )
      throw new ContractValidationError("Invalid browser authentication reply");
    const reply = await control.request({
      method: "host.attach",
      params: {
        clientKind: "browser",
        clientId,
        expectedHostId,
        supportedProtocolVersions: ["0.1"],
      },
    });
    if (!reply.ok) throw new HostRequestError(reply.error);
    const attachment = reply.result;
    if (!("requestContext" in attachment) || attachment.clientId !== clientId)
      throw new ContractValidationError("Invalid browser attachment");
    const token = authenticated.rawAttachToken;
    let raw: Promise<BrowserSocket> | undefined;
    function rawSocket(signal?: AbortSignal) {
      if (control.closed.aborted) return Promise.reject(control.failure);
      if (signal?.aborted) return Promise.reject(abortError());
      if (raw) return waitForHost(raw, signal);
      const forget = () => {
        if (raw === opening) raw = undefined;
      };
      const opening = (async () => {
        const socket = await BrowserSocket.open(endpoint, "raw");
        const close = () => socket.close();
        if (control.closed.aborted) {
          close();
          throw control.failure;
        }
        control.closed.addEventListener("abort", close, { once: true });
        socket.closed.addEventListener(
          "abort",
          () => {
            control.closed.removeEventListener("abort", close);
            forget();
          },
          { once: true },
        );
        try {
          const attached = await socket.exchange(
            { type: "rawAttach", token },
            undefined,
            HANDSHAKE_TIMEOUT,
          );
          if (attached.type !== "rawAttached")
            throw new ContractValidationError("Invalid browser Raw attachment");
          return socket;
        } catch (error) {
          close();
          throw error;
        }
      })();
      raw = opening;
      void opening.catch(forget);
      return waitForHost(opening, signal);
    }
    const scopes = new Map<string, Target>();
    const transport = {
      getAttachment: () => attachment,
      resolveScope(scopeId: string) {
        const target = scopes.get(scopeId);
        if (target) return target;
        throw new HostRequestError({
          code: "NOT_FOUND",
          message: "Host did not authorize this state scope",
          retryable: false,
        });
      },
      setScopes(values: StateScopeRef[]) {
        scopes.clear();
        for (const value of values) scopes.set(value.scopeId, value.target);
      },
      request(request, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        return waitForHost(control.request(request), signal);
      },
      openChannel(query, onFrame, signal) {
        return subscribe(
          control,
          query,
          {
            onFrame,
            onError: (error) =>
              onFrame({
                requestId: query.requestId,
                channel: "state",
                body: {
                  type: "error",
                  error:
                    error instanceof HostRequestError
                      ? error.details
                      : {
                          code: "CHANNEL_FAILED",
                          message: error.message,
                          retryable: false,
                        },
                },
              }),
          },
          signal,
        );
      },
      async openRawChannel(
        query,
        onBatch,
        onLifecycle,
        signal,
        onError = () => {},
      ) {
        return subscribe(
          await rawSocket(signal),
          query,
          {
            onFrame: (frame) => {
              if (frame.body.type === "rawBatch") onBatch(frame.body.batch);
              else onLifecycle(frame);
            },
            onError,
          },
          signal,
        );
      },
      async rawRequest(request, signal) {
        const socket = await rawSocket(signal);
        if (signal?.aborted) throw abortError();
        return waitForHost(socket.request(request), signal);
      },
      dispose: () => control.close(),
    } satisfies WorkbenchHostTransport;
    const generation = crypto.randomUUID();
    const connection = bindHostConnection(
      transport,
      () => generation,
      async (listener) => {
        if (!control.closed.aborted) control.catalog.add(listener);
        return () => {
          control.catalog.delete(listener);
        };
      },
    );
    async function openViewConnection(signal: AbortSignal) {
      const lifetime = AbortSignal.any([signal, control.closed]);
      lifetime.throwIfAborted();
      // Host 为每条 Control 连接保留一条 Raw 附着。视图用同一浏览器身份单独附着。
      const pending = createBrowserHostConnection(credential, {
        expectedHostId: connection.attachment.hostId,
      });
      void pending.then(
        (view) => {
          if (lifetime.aborted) view.dispose();
        },
        () => {},
      );
      const view = await waitForHost(pending, lifetime);
      if (
        view.attachment.instanceEpoch !== connection.attachment.instanceEpoch ||
        view.attachment.actorId !== connection.attachment.actorId ||
        view.attachment.clientId !== connection.attachment.clientId
      ) {
        view.dispose();
        throw new ContractValidationError(
          "Browser view Host attachment changed",
        );
      }
      lifetime.addEventListener("abort", view.dispose, { once: true });
      return view;
    }
    return {
      ...connection,
      browser: { closed: control.closed, openViewConnection },
    };
  } catch (error) {
    control.close();
    throw error;
  }
}
