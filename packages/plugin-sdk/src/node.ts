import type {
  Call,
  ChildCall,
  NodeContributionSelection,
  NodePackagePath,
  Operation,
  OperationGetParams,
  DerivedPublishParams,
  DerivedPublishResult,
  Progress,
  Query,
  QueryValue,
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

export interface TaskStreams {
  /** 读留存原始事件。下一页沿用 nextEventSeq，过期会明确报告缺口。 */
  read(params: StreamReadParams): Promise<StreamReadResult>;
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
  readonly queries: NodeQueries;
  readonly workers: NodeWorkers;
}

/** 后台模块导出 register，且必须返回实际清理函数；两层都可以异步。 */
export type NodeRegister = (
  context: NodeContext,
) => NodeDispose | PromiseLike<NodeDispose>;
