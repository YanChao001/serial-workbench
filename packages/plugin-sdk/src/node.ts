import type {
  Call,
  ChildCall,
  NodeContributionSelection,
  NodePackagePath,
  Operation,
  OperationGetParams,
  DerivedPublishParams,
  DerivedPublishResult,
  Cursor,
  Progress,
  Query,
  QueryValue,
  RawEvent,
  StreamReadParams,
  StreamReadResult,
} from "@serial-workbench/contracts";

export type {
  Call,
  NodeContributionSelection,
  NodePackagePath,
  Operation,
  OperationGetParams,
  DerivedPublishParams,
  DerivedPublishResult,
  DerivedQuality,
  Progress,
  Query,
  QueryValue,
  StreamReadParams,
  StreamReadResult,
  SourceRange,
} from "@serial-workbench/contracts";

/** 子身份、调用者和执行模式由 Host 与任务桥持有，插件只提供业务意图。 */
export type ChildActionIntent = Pick<
  ChildCall,
  "actionId" | "target" | "params" | "expectedRevision" | "leaseId"
> &
  Partial<Pick<ChildCall, "revealTarget">>;

/** 返回的是接纳 Operation；实际结果通过 operations.get 读取。 */
export interface TaskActions {
  invokeChild(intent: ChildActionIntent): Promise<Operation>;
}

export interface TaskOperations {
  get(selector: OperationGetParams): Promise<Operation>;
}

type SessionEvent<Kind extends RawEvent["kind"]> = Extract<
  RawEvent,
  { kind: Kind }
>;

export type SessionHookEnd = Readonly<{
  after: Readonly<Cursor>;
  reason: Readonly<
    { kind: "closed" } | { kind: "backend_fault"; code?: string }
  >;
  txEvidenceGap: boolean;
}>;

export type SessionHookError =
  | { kind: "source_gap"; event: SessionEvent<"gap"> }
  | { kind: "cursor_expired"; oldestCursor: Cursor }
  | { kind: "tx_evidence_gap"; end: SessionHookEnd }
  | { kind: "backend_fault"; end: SessionHookEnd };

type SessionHook<T> = (value: Readonly<T>) => void | PromiseLike<void>;

export interface SessionHooks {
  onConnect?: SessionHook<SessionEvent<"lifecycle">>;
  onReceive?: SessionHook<SessionEvent<"rx">>;
  /** 实际 TX 结算，包含已接纳及无法确认的范围。 */
  onSend?: SessionHook<SessionEvent<"tx">>;
  onDisconnect?: SessionHook<SessionHookEnd>;
  /** 处理缺口时应丢弃未完成的解析状态。 */
  onError: SessionHook<SessionHookError>;
}

export interface TaskStreams {
  /** 读留存原始事件。下一页沿用 nextEventSeq，过期会明确报告缺口。 */
  read(params: StreamReadParams): Promise<StreamReadResult>;
  /** 监听指定会话代次，按顺序等待回调，随任务取消及真实流终态清理。 */
  followSession(params: StreamReadParams, hooks: SessionHooks): Promise<void>;
  /** 发布带真实源区间的派生值，返回 Host 分配的序号。 */
  publishDerived(params: DerivedPublishParams): Promise<DerivedPublishResult>;
}

export interface TaskProgress {
  /** 计数使用 U64 十进制字符串；completed 单调，unit 和 total 在任务内固定。 */
  report(progress: Progress): void;
}

/** 公开 Host 动作实际派发到处理器时的任务上下文。 */
export type NodeTaskContext = Readonly<Pick<ChildCall, "taskContext">> & {
  readonly signal: AbortSignal;
  readonly actions: TaskActions;
  readonly operations: TaskOperations;
  readonly streams: TaskStreams;
  readonly progress: TaskProgress;
};

export type NodeActionHandler<Result extends QueryValue = QueryValue> = (
  call: Readonly<Call>,
  task: NodeTaskContext,
) => Result | PromiseLike<Result>;

export type NodeQueryHandler<Result extends QueryValue = QueryValue> = (
  query: Readonly<Query>,
) => Result | PromiseLike<Result>;

export interface NodeActions {
  register<Result extends QueryValue>(
    actionId: Call["actionId"],
    handler: NodeActionHandler<Result>,
  ): void;
}

export interface NodeQueries {
  register<Result extends QueryValue>(
    actionId: Query["actionId"],
    handler: NodeQueryHandler<Result>,
  ): void;
}

export interface NodeConfiguration {
  registerQuery: NodeQueries["register"];
  registerAction: NodeActions["register"];
}

export interface TransportOpenOptions {
  readonly params: Readonly<Call["params"]>;
  readonly signal: AbortSignal;
}

export interface TransportReadOptions {
  readonly maxBytes: number;
  readonly waitMs: number;
  readonly signal: AbortSignal;
}

export interface TransportWriteOptions {
  readonly bytes: Uint8Array;
  readonly waitMs: number;
  readonly signal: AbortSignal;
}

export type TransportOutputLine = "dtr" | "rts";
export type TransportLineResult =
  { kind: "confirmed"; actual: boolean } | { kind: "not_applied" };

export interface TransportLineControls {
  readonly dtr: boolean;
  readonly rts: boolean;
  /** 应答明确时返回实际值。能证明未提交时报告 not_applied。提交后结果不明时抛出错误。 */
  set(options: {
    line: TransportOutputLine;
    value: boolean;
    waitMs: number;
    signal: AbortSignal;
  }): TransportLineResult | Promise<TransportLineResult>;
}

export interface TransportConnection {
  /** 只在当前连接确实支持的线路上声明此能力。 */
  readonly lineControls?: TransportLineControls;
  /** 最多返回 maxBytes 字节。空数组表示本次没有数据，null 表示输入已结束。 */
  read(
    options: TransportReadOptions,
  ): Uint8Array | null | Promise<Uint8Array | null>;
  /** 返回已确认接纳的连续前缀字节数。无法确认接纳时抛出错误。 */
  write(options: TransportWriteOptions): number | Promise<number>;
  /** 等待底层连接实际关闭，可重复调用。 */
  close(): void | Promise<void>;
}

export interface TransportMessage {
  readonly bytes: Uint8Array;
  readonly messageType: "binary" | "text" | "datagram";
}

export interface TransportMessageConnection extends Omit<
  TransportConnection,
  "read" | "lineControls"
> {
  /** 返回完整消息。undefined 表示本次没有消息，null 表示输入已结束。 */
  readMessage(
    options: TransportReadOptions,
  ):
    | TransportMessage
    | undefined
    | null
    | Promise<TransportMessage | undefined | null>;
  /** 接纳整条消息时返回输入长度，未接纳时返回零，无法确认时抛错。 */
  write(options: TransportWriteOptions): number | Promise<number>;
}

type OpenTransport = TransportConnection | TransportMessageConnection;

export type TransportOpenHandler = (
  options: TransportOpenOptions,
) => OpenTransport | Promise<OpenTransport>;

export interface NodeTransports {
  register(actionId: Call["actionId"], open: TransportOpenHandler): void;
}

export interface NodeContributions {
  register(selection: NodeContributionSelection): void;
}

/** 本地 worker 句柄的实际退出结果，不是 Host wire DTO。 */
export interface NodeWorkerExit {
  readonly exitCode: number;
}

export interface NodeWorker {
  readonly finished: Promise<NodeWorkerExit>;
  terminate(): Promise<NodeWorkerExit>;
}

export interface NodeWorkers {
  /** entry 相对已验证包根目录；动作异步链内创建的 worker 归属该任务。 */
  start(entry: NodePackagePath): NodeWorker;
}

export type NodeDispose = () => void | PromiseLike<void>;

export interface NodeContext {
  onDispose(cleanup: NodeDispose): void;
  readonly contributions: NodeContributions;
  readonly actions: NodeActions;
  /** 按已签名的解析器声明登记会话动作。 */
  readonly parsers: NodeActions;
  readonly queries: NodeQueries;
  readonly configuration: NodeConfiguration;
  readonly transports: NodeTransports;
  readonly workers: NodeWorkers;
}

/** 后台模块导出 register，且必须返回实际清理函数；两层都可以异步。 */
export type NodeRegister = (
  context: NodeContext,
) => NodeDispose | PromiseLike<NodeDispose>;
