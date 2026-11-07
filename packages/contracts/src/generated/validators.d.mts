// Generated from Rust core DTOs. Do not edit.
import type {
  ActionKind,
  ActionResult,
  ActionSpec,
  Admission,
  AttachParams,
  AttachResult,
  AuthorizationResult,
  AuthorizeParams,
  BreakParams,
  BreakReceipt,
  ByteRange,
  Bytes,
  Call,
  CancelReason,
  Cancellation,
  CancellationResult,
  CatalogListParams,
  CatalogListResult,
  Certainty,
  ChildCall,
  ClientKind,
  ClosedResult,
  ConfigField,
  ConfigReceipt,
  ConfigurationBoundary,
  ConfigureParams,
  ContextToken,
  ControlLine,
  ControlParams,
  ControlReceipt,
  ControlState,
  ControlStatus,
  ControlTransition,
  Cursor,
  DataBits,
  Delta,
  Dependency,
  DeviceDescriptor,
  DeviceList,
  Digest,
  Direction,
  DirectionalRange,
  DrainParams,
  DrainReceipt,
  DurationMs,
  EmptyParams,
  EventTime,
  ExecutionLocation,
  ExecutionMode,
  ExplicitLeaseKind,
  FieldStatus,
  FlowControl,
  HostError,
  Id,
  IpcChannel,
  IpcMessage,
  JsonValue,
  Lease,
  LeaseAcquireParams,
  LeaseKind,
  LeaseReleaseParams,
  LeaseRenewParams,
  LeaseState,
  Limits,
  MessageFragment,
  ObjectReadResult,
  ObjectRef,
  OpenParams,
  OpenResult,
  Operation,
  OperationCancelParams,
  OperationGetParams,
  OperationResult,
  OperationState,
  OverflowPolicy,
  Owner,
  OwnerKind,
  Parity,
  PositiveU64,
  Progress,
  ProtocolVersion,
  PurgeDirection,
  PurgeOutcome,
  PurgeParams,
  PurgeReceipt,
  PurgeScope,
  Query,
  QueryResult,
  QueueStatus,
  RawBatch,
  RawEvent,
  RawPayload,
  ReaderGap,
  ReaderGapReason,
  RequestId,
  ResourceKind,
  ResultReference,
  RetentionMs,
  RevealTarget,
  RevokeParams,
  RpcReply,
  RpcRequest,
  RpcResult,
  RxPayload,
  SafeInteger,
  SerialConfiguration,
  SessionSnapshot,
  SessionState,
  SetReadOnlyParams,
  ShutdownRequested,
  SignedDecimal,
  Snapshot,
  SourceGap,
  SourceGapReason,
  StateSnapshotParams,
  StateSubscribeParams,
  StopBits,
  StreamCreditParams,
  StreamCreditResult,
  StreamItem,
  StreamReadParams,
  StreamReadResult,
  StreamSubscribeParams,
  StreamSubscribeResult,
  SubscriptionCloseParams,
  SubscriptionResult,
  TakeoverParams,
  TakeoverReason,
  TakeoverReceipt,
  Target,
  TimePrecision,
  TimeSource,
  Timestamp,
  TransformReference,
  TransportCapabilities,
  TransportSemantics,
  TxGate,
  TxIntent,
  TxOutcome,
  TxParams,
  TxReceipt,
  U64,
  WaitBoundaryParams,
  WaitBoundaryReceipt,
  WireFrame,
} from "./types.ts";
export declare function validateActionKind(value: unknown): value is ActionKind;
export declare function validateActionResult(
  value: unknown,
): value is ActionResult;
export declare function validateActionSpec(value: unknown): value is ActionSpec;
export declare function validateAdmission(value: unknown): value is Admission;
export declare function validateAttachParams(
  value: unknown,
): value is AttachParams;
export declare function validateAttachResult(
  value: unknown,
): value is AttachResult;
export declare function validateAuthorizationResult(
  value: unknown,
): value is AuthorizationResult;
export declare function validateAuthorizeParams(
  value: unknown,
): value is AuthorizeParams;
export declare function validateBreakParams(
  value: unknown,
): value is BreakParams;
export declare function validateBreakReceipt(
  value: unknown,
): value is BreakReceipt;
export declare function validateByteRange(value: unknown): value is ByteRange;
export declare function validateBytes(value: unknown): value is Bytes;
export declare function validateCall(value: unknown): value is Call;
export declare function validateCancelReason(
  value: unknown,
): value is CancelReason;
export declare function validateCancellation(
  value: unknown,
): value is Cancellation;
export declare function validateCancellationResult(
  value: unknown,
): value is CancellationResult;
export declare function validateCatalogListParams(
  value: unknown,
): value is CatalogListParams;
export declare function validateCatalogListResult(
  value: unknown,
): value is CatalogListResult;
export declare function validateCertainty(value: unknown): value is Certainty;
export declare function validateChildCall(value: unknown): value is ChildCall;
export declare function validateClientKind(value: unknown): value is ClientKind;
export declare function validateClosedResult(
  value: unknown,
): value is ClosedResult;
export declare function validateConfigField(
  value: unknown,
): value is ConfigField;
export declare function validateConfigReceipt(
  value: unknown,
): value is ConfigReceipt;
export declare function validateConfigurationBoundary(
  value: unknown,
): value is ConfigurationBoundary;
export declare function validateConfigureParams(
  value: unknown,
): value is ConfigureParams;
export declare function validateContextToken(
  value: unknown,
): value is ContextToken;
export declare function validateControlLine(
  value: unknown,
): value is ControlLine;
export declare function validateControlParams(
  value: unknown,
): value is ControlParams;
export declare function validateControlReceipt(
  value: unknown,
): value is ControlReceipt;
export declare function validateControlState(
  value: unknown,
): value is ControlState;
export declare function validateControlStatus(
  value: unknown,
): value is ControlStatus;
export declare function validateControlTransition(
  value: unknown,
): value is ControlTransition;
export declare function validateCursor(value: unknown): value is Cursor;
export declare function validateDataBits(value: unknown): value is DataBits;
export declare function validateDelta(value: unknown): value is Delta;
export declare function validateDependency(value: unknown): value is Dependency;
export declare function validateDeviceDescriptor(
  value: unknown,
): value is DeviceDescriptor;
export declare function validateDeviceList(value: unknown): value is DeviceList;
export declare function validateDigest(value: unknown): value is Digest;
export declare function validateDirection(value: unknown): value is Direction;
export declare function validateDirectionalRange(
  value: unknown,
): value is DirectionalRange;
export declare function validateDrainParams(
  value: unknown,
): value is DrainParams;
export declare function validateDrainReceipt(
  value: unknown,
): value is DrainReceipt;
export declare function validateDurationMs(value: unknown): value is DurationMs;
export declare function validateEmptyParams(
  value: unknown,
): value is EmptyParams;
export declare function validateEventTime(value: unknown): value is EventTime;
export declare function validateExecutionLocation(
  value: unknown,
): value is ExecutionLocation;
export declare function validateExecutionMode(
  value: unknown,
): value is ExecutionMode;
export declare function validateExplicitLeaseKind(
  value: unknown,
): value is ExplicitLeaseKind;
export declare function validateFieldStatus(
  value: unknown,
): value is FieldStatus;
export declare function validateFlowControl(
  value: unknown,
): value is FlowControl;
export declare function validateHostError(value: unknown): value is HostError;
export declare function validateId(value: unknown): value is Id;
export declare function validateIpcChannel(value: unknown): value is IpcChannel;
export declare function validateIpcMessage(value: unknown): value is IpcMessage;
export declare function validateJsonValue(value: unknown): value is JsonValue;
export declare function validateLease(value: unknown): value is Lease;
export declare function validateLeaseAcquireParams(
  value: unknown,
): value is LeaseAcquireParams;
export declare function validateLeaseKind(value: unknown): value is LeaseKind;
export declare function validateLeaseReleaseParams(
  value: unknown,
): value is LeaseReleaseParams;
export declare function validateLeaseRenewParams(
  value: unknown,
): value is LeaseRenewParams;
export declare function validateLeaseState(value: unknown): value is LeaseState;
export declare function validateLimits(value: unknown): value is Limits;
export declare function validateMessageFragment(
  value: unknown,
): value is MessageFragment;
export declare function validateObjectReadResult(
  value: unknown,
): value is ObjectReadResult;
export declare function validateObjectRef(value: unknown): value is ObjectRef;
export declare function validateOpenParams(value: unknown): value is OpenParams;
export declare function validateOpenResult(value: unknown): value is OpenResult;
export declare function validateOperation(value: unknown): value is Operation;
export declare function validateOperationCancelParams(
  value: unknown,
): value is OperationCancelParams;
export declare function validateOperationGetParams(
  value: unknown,
): value is OperationGetParams;
export declare function validateOperationResult(
  value: unknown,
): value is OperationResult;
export declare function validateOperationState(
  value: unknown,
): value is OperationState;
export declare function validateOverflowPolicy(
  value: unknown,
): value is OverflowPolicy;
export declare function validateOwner(value: unknown): value is Owner;
export declare function validateOwnerKind(value: unknown): value is OwnerKind;
export declare function validateParity(value: unknown): value is Parity;
export declare function validatePositiveU64(
  value: unknown,
): value is PositiveU64;
export declare function validateProgress(value: unknown): value is Progress;
export declare function validateProtocolVersion(
  value: unknown,
): value is ProtocolVersion;
export declare function validatePurgeDirection(
  value: unknown,
): value is PurgeDirection;
export declare function validatePurgeOutcome(
  value: unknown,
): value is PurgeOutcome;
export declare function validatePurgeParams(
  value: unknown,
): value is PurgeParams;
export declare function validatePurgeReceipt(
  value: unknown,
): value is PurgeReceipt;
export declare function validatePurgeScope(value: unknown): value is PurgeScope;
export declare function validateQuery(value: unknown): value is Query;
export declare function validateQueryResult(
  value: unknown,
): value is QueryResult;
export declare function validateQueueStatus(
  value: unknown,
): value is QueueStatus;
export declare function validateRawBatch(value: unknown): value is RawBatch;
export declare function validateRawEvent(value: unknown): value is RawEvent;
export declare function validateRawPayload(value: unknown): value is RawPayload;
export declare function validateReaderGap(value: unknown): value is ReaderGap;
export declare function validateReaderGapReason(
  value: unknown,
): value is ReaderGapReason;
export declare function validateRequestId(value: unknown): value is RequestId;
export declare function validateResourceKind(
  value: unknown,
): value is ResourceKind;
export declare function validateResultReference(
  value: unknown,
): value is ResultReference;
export declare function validateRetentionMs(
  value: unknown,
): value is RetentionMs;
export declare function validateRevealTarget(
  value: unknown,
): value is RevealTarget;
export declare function validateRevokeParams(
  value: unknown,
): value is RevokeParams;
export declare function validateRpcReply(value: unknown): value is RpcReply;
export declare function validateRpcRequest(value: unknown): value is RpcRequest;
export declare function validateRpcResult(value: unknown): value is RpcResult;
export declare function validateRxPayload(value: unknown): value is RxPayload;
export declare function validateSafeInteger(
  value: unknown,
): value is SafeInteger;
export declare function validateSerialConfiguration(
  value: unknown,
): value is SerialConfiguration;
export declare function validateSessionSnapshot(
  value: unknown,
): value is SessionSnapshot;
export declare function validateSessionState(
  value: unknown,
): value is SessionState;
export declare function validateSetReadOnlyParams(
  value: unknown,
): value is SetReadOnlyParams;
export declare function validateShutdownRequested(
  value: unknown,
): value is ShutdownRequested;
export declare function validateSignedDecimal(
  value: unknown,
): value is SignedDecimal;
export declare function validateSnapshot(value: unknown): value is Snapshot;
export declare function validateSourceGap(value: unknown): value is SourceGap;
export declare function validateSourceGapReason(
  value: unknown,
): value is SourceGapReason;
export declare function validateStateSnapshotParams(
  value: unknown,
): value is StateSnapshotParams;
export declare function validateStateSubscribeParams(
  value: unknown,
): value is StateSubscribeParams;
export declare function validateStopBits(value: unknown): value is StopBits;
export declare function validateStreamCreditParams(
  value: unknown,
): value is StreamCreditParams;
export declare function validateStreamCreditResult(
  value: unknown,
): value is StreamCreditResult;
export declare function validateStreamItem(value: unknown): value is StreamItem;
export declare function validateStreamReadParams(
  value: unknown,
): value is StreamReadParams;
export declare function validateStreamReadResult(
  value: unknown,
): value is StreamReadResult;
export declare function validateStreamSubscribeParams(
  value: unknown,
): value is StreamSubscribeParams;
export declare function validateStreamSubscribeResult(
  value: unknown,
): value is StreamSubscribeResult;
export declare function validateSubscriptionCloseParams(
  value: unknown,
): value is SubscriptionCloseParams;
export declare function validateSubscriptionResult(
  value: unknown,
): value is SubscriptionResult;
export declare function validateTakeoverParams(
  value: unknown,
): value is TakeoverParams;
export declare function validateTakeoverReason(
  value: unknown,
): value is TakeoverReason;
export declare function validateTakeoverReceipt(
  value: unknown,
): value is TakeoverReceipt;
export declare function validateTarget(value: unknown): value is Target;
export declare function validateTimePrecision(
  value: unknown,
): value is TimePrecision;
export declare function validateTimeSource(value: unknown): value is TimeSource;
export declare function validateTimestamp(value: unknown): value is Timestamp;
export declare function validateTransformReference(
  value: unknown,
): value is TransformReference;
export declare function validateTransportCapabilities(
  value: unknown,
): value is TransportCapabilities;
export declare function validateTransportSemantics(
  value: unknown,
): value is TransportSemantics;
export declare function validateTxGate(value: unknown): value is TxGate;
export declare function validateTxIntent(value: unknown): value is TxIntent;
export declare function validateTxOutcome(value: unknown): value is TxOutcome;
export declare function validateTxParams(value: unknown): value is TxParams;
export declare function validateTxReceipt(value: unknown): value is TxReceipt;
export declare function validateU64(value: unknown): value is U64;
export declare function validateWaitBoundaryParams(
  value: unknown,
): value is WaitBoundaryParams;
export declare function validateWaitBoundaryReceipt(
  value: unknown,
): value is WaitBoundaryReceipt;
export declare function validateWireFrame(value: unknown): value is WireFrame;
