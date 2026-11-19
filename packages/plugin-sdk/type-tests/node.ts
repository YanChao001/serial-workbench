import type {
  Call,
  ChildActionIntent,
  DerivedPublishParams,
  NodeContext,
  NodeRegister,
  NodeTaskContext,
} from "@serial-workbench/plugin-sdk/node";

export function authoringConstraints(
  context: NodeContext,
  call: Call,
  task: NodeTaskContext,
) {
  const intent: ChildActionIntent = {
    actionId: "session.tx",
    target: call.target,
    params: { bytesBase64: "AQ==", writeWaitMs: "100" },
    // @ts-expect-error 子键由SDK分配，作者不能选择身份。
    childKey: "1",
  };
  void task.actions.invokeChild(intent);
  // @ts-expect-error 进度计数使用生成契约的U64字符串。
  task.progress.report({ completed: 1, unit: "jobs" });
  const read = {
    sessionId: "session",
    sessionEpoch: "1",
    startEventSeq: "1",
    maxEvents: "8",
    maxBytes: "32768",
  };
  void task.streams.read(read).then((page) => page.nextEventSeq);
  // @ts-expect-error 正文字节上限沿用 Host 契约的U64字符串。
  void task.streams.read({ ...read, maxBytes: 32768 });
  const publication: DerivedPublishParams = {
    sources: [
      {
        hostId: call.hostId,
        sessionId: read.sessionId,
        sessionEpoch: read.sessionEpoch,
        eventStart: "1",
        eventEnd: "2",
        byteStart: "0",
        byteEnd: "4",
        direction: "rx",
      },
    ],
    quality: ["complete", "transformed"],
    unit: "bytes",
    value: 4,
  };
  void task.streams
    .publishDerived(publication)
    .then((receipt) => receipt.position);
  // @ts-expect-error 来源质量沿用受约束的生成契约。
  void task.streams.publishDerived({ ...publication, quality: ["verified"] });
  // @ts-expect-error 查询没有任务上下文参数。
  context.queries.register("example.status", (_query, _task) => ({}));
  // @ts-expect-error register必须返回清理函数。
  const missingDispose: NodeRegister = () => {};
  return missingDispose;
}
