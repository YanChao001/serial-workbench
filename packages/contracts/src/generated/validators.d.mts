// Generated from Rust core DTOs. Do not edit.
import type {
  Accent,
  ActionCheckParams,
  ActionCheckResult,
  ActionKind,
  ActionResult,
  ActionSpec,
  Admission,
  AttachParams,
  AttachResult,
  AuthorizationResult,
  AuthorizeParams,
  BackgroundFit,
  BackgroundPreset,
  BackgroundSelection,
  BreakParams,
  BreakReceipt,
  ByteRange,
  Bytes,
  Call,
  CancelReason,
  Cancellation,
  CancellationResult,
  CaptureRecord,
  CaptureStartParams,
  CaptureStatusResult,
  CaptureStopParams,
  CaptureStorageLimits,
  CaptureTailParams,
  CaptureTailResult,
  CaptureTxSettlement,
  CaptureVerifyParams,
  CatalogListParams,
  CatalogListResult,
  Certainty,
  ChildCall,
  ClientAutostartParams,
  ClientCapability,
  ClientClipboardWriteParams,
  ClientEffectAcknowledged,
  ClientEffectAction,
  ClientEffectOutcome,
  ClientEffectReceipt,
  ClientEffectRequest,
  ClientEffectResult,
  ClientFullscreenParams,
  ClientKind,
  ClientListItem,
  ClientListResult,
  ClientReceiptSubmission,
  ClientRegisterParams,
  ClientRegistration,
  ClientResetGeometryParams,
  ClientSettingsObservation,
  ClientUnregisterParams,
  ClientWindowSizeParams,
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
  DeviceBindingReference,
  DeviceDescriptor,
  DeviceList,
  Digest,
  Direction,
  DirectionalRange,
  DocumentImportParams,
  DocumentJsonResult,
  DrainParams,
  DrainReceipt,
  DurationMs,
  EmptyParams,
  EventTime,
  ExecutionLocation,
  ExecutionMode,
  ExplicitLeaseKind,
  FavoritesSaveParams,
  FieldStatus,
  FileMetadata,
  FileMetadataParams,
  FileReadParams,
  FileReadResult,
  FileTransferParams,
  FileTransferReceipt,
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  FileTransferResult,
  FlowControl,
  Font,
  FontSize,
  HostError,
  HostMetrics,
  HostMetricsParams,
  Id,
  IpcChannel,
  IpcMessage,
  JsonValue,
  Language,
  LayoutTemplate,
  Lease,
  LeaseAcquireParams,
  LeaseKind,
  LeaseReleaseParams,
  LeaseRenewParams,
  LeaseState,
  Limits,
  LineEnding,
  MemoryBudget,
  MessageFragment,
  Motion,
  NetworkMode,
  ObjectReadResult,
  ObjectRef,
  OpenParams,
  OpenResult,
  Operation,
  OperationCancelParams,
  OperationGetParams,
  OperationInput,
  OperationInputParams,
  OperationInputRedaction,
  OperationResult,
  OperationState,
  OperationSummary,
  OperationsSnapshot,
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
  Radius,
  RawBatch,
  RawEvent,
  RawPayload,
  ReaderGap,
  ReaderGapReason,
  RebindParams,
  RecentList,
  ReconnectState,
  ReconnectStatus,
  RecoverPrefixParams,
  RegisterFileParams,
  ReplayControlParams,
  ReplayOpenParams,
  ReplayReadParams,
  ReplayReadResult,
  ReplayRecord,
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
  SessionInputs,
  SessionMetrics,
  SessionSnapshot,
  SessionState,
  SetReadOnlyParams,
  SettingsDocumentResult,
  SettingsSaveParams,
  SettingsSnapshot,
  SharedSettings,
  ShutdownMode,
  ShutdownReport,
  ShutdownRequested,
  SignedDecimal,
  Snapshot,
  SourceGap,
  SourceGapReason,
  StartupConfigSnapshot,
  StartupConfigSource,
  StartupLogLevel,
  StartupProfileReference,
  StateScopeRef,
  StateScopesResult,
  StateSnapshotParams,
  StateSubscribeParams,
  StopBits,
  StreamCreditParams,
  StreamCreditResult,
  StreamCursorResult,
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
  TerminalMode,
  TerminalSettings,
  TerminalTypography,
  TextExportParams,
  Theme,
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
  VerificationReport,
  WaitBoundaryParams,
  WaitBoundaryReceipt,
  WireFrame,
  WorkspaceDocument,
  WorkspaceDocumentResult,
  WorkspaceSaveParams,
  WorkspaceSnapshot,
  WorkspaceView,
} from "./types.ts";
export declare function validateAccent(value: unknown): value is Accent;
export declare function validateActionCheckParams(
  value: unknown,
): value is ActionCheckParams;
export declare function validateActionCheckResult(
  value: unknown,
): value is ActionCheckResult;
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
export declare function validateBackgroundFit(
  value: unknown,
): value is BackgroundFit;
export declare function validateBackgroundPreset(
  value: unknown,
): value is BackgroundPreset;
export declare function validateBackgroundSelection(
  value: unknown,
): value is BackgroundSelection;
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
export declare function validateCaptureRecord(
  value: unknown,
): value is CaptureRecord;
export declare function validateCaptureStartParams(
  value: unknown,
): value is CaptureStartParams;
export declare function validateCaptureStatusResult(
  value: unknown,
): value is CaptureStatusResult;
export declare function validateCaptureStopParams(
  value: unknown,
): value is CaptureStopParams;
export declare function validateCaptureStorageLimits(
  value: unknown,
): value is CaptureStorageLimits;
export declare function validateCaptureTailParams(
  value: unknown,
): value is CaptureTailParams;
export declare function validateCaptureTailResult(
  value: unknown,
): value is CaptureTailResult;
export declare function validateCaptureTxSettlement(
  value: unknown,
): value is CaptureTxSettlement;
export declare function validateCaptureVerifyParams(
  value: unknown,
): value is CaptureVerifyParams;
export declare function validateCatalogListParams(
  value: unknown,
): value is CatalogListParams;
export declare function validateCatalogListResult(
  value: unknown,
): value is CatalogListResult;
export declare function validateCertainty(value: unknown): value is Certainty;
export declare function validateChildCall(value: unknown): value is ChildCall;
export declare function validateClientAutostartParams(
  value: unknown,
): value is ClientAutostartParams;
export declare function validateClientCapability(
  value: unknown,
): value is ClientCapability;
export declare function validateClientClipboardWriteParams(
  value: unknown,
): value is ClientClipboardWriteParams;
export declare function validateClientEffectAcknowledged(
  value: unknown,
): value is ClientEffectAcknowledged;
export declare function validateClientEffectAction(
  value: unknown,
): value is ClientEffectAction;
export declare function validateClientEffectOutcome(
  value: unknown,
): value is ClientEffectOutcome;
export declare function validateClientEffectReceipt(
  value: unknown,
): value is ClientEffectReceipt;
export declare function validateClientEffectRequest(
  value: unknown,
): value is ClientEffectRequest;
export declare function validateClientEffectResult(
  value: unknown,
): value is ClientEffectResult;
export declare function validateClientFullscreenParams(
  value: unknown,
): value is ClientFullscreenParams;
export declare function validateClientKind(value: unknown): value is ClientKind;
export declare function validateClientListItem(
  value: unknown,
): value is ClientListItem;
export declare function validateClientListResult(
  value: unknown,
): value is ClientListResult;
export declare function validateClientReceiptSubmission(
  value: unknown,
): value is ClientReceiptSubmission;
export declare function validateClientRegisterParams(
  value: unknown,
): value is ClientRegisterParams;
export declare function validateClientRegistration(
  value: unknown,
): value is ClientRegistration;
export declare function validateClientResetGeometryParams(
  value: unknown,
): value is ClientResetGeometryParams;
export declare function validateClientSettingsObservation(
  value: unknown,
): value is ClientSettingsObservation;
export declare function validateClientUnregisterParams(
  value: unknown,
): value is ClientUnregisterParams;
export declare function validateClientWindowSizeParams(
  value: unknown,
): value is ClientWindowSizeParams;
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
export declare function validateDeviceBindingReference(
  value: unknown,
): value is DeviceBindingReference;
export declare function validateDeviceDescriptor(
  value: unknown,
): value is DeviceDescriptor;
export declare function validateDeviceList(value: unknown): value is DeviceList;
export declare function validateDigest(value: unknown): value is Digest;
export declare function validateDirection(value: unknown): value is Direction;
export declare function validateDirectionalRange(
  value: unknown,
): value is DirectionalRange;
export declare function validateDocumentImportParams(
  value: unknown,
): value is DocumentImportParams;
export declare function validateDocumentJsonResult(
  value: unknown,
): value is DocumentJsonResult;
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
export declare function validateFavoritesSaveParams(
  value: unknown,
): value is FavoritesSaveParams;
export declare function validateFieldStatus(
  value: unknown,
): value is FieldStatus;
export declare function validateFileMetadata(
  value: unknown,
): value is FileMetadata;
export declare function validateFileMetadataParams(
  value: unknown,
): value is FileMetadataParams;
export declare function validateFileReadParams(
  value: unknown,
): value is FileReadParams;
export declare function validateFileReadResult(
  value: unknown,
): value is FileReadResult;
export declare function validateFileTransferParams(
  value: unknown,
): value is FileTransferParams;
export declare function validateFileTransferReceipt(
  value: unknown,
): value is FileTransferReceipt;
export declare function validateFileTransferReceiptsParams(
  value: unknown,
): value is FileTransferReceiptsParams;
export declare function validateFileTransferReceiptsResult(
  value: unknown,
): value is FileTransferReceiptsResult;
export declare function validateFileTransferResult(
  value: unknown,
): value is FileTransferResult;
export declare function validateFlowControl(
  value: unknown,
): value is FlowControl;
export declare function validateFont(value: unknown): value is Font;
export declare function validateFontSize(value: unknown): value is FontSize;
export declare function validateHostError(value: unknown): value is HostError;
export declare function validateHostMetrics(
  value: unknown,
): value is HostMetrics;
export declare function validateHostMetricsParams(
  value: unknown,
): value is HostMetricsParams;
export declare function validateId(value: unknown): value is Id;
export declare function validateIpcChannel(value: unknown): value is IpcChannel;
export declare function validateIpcMessage(value: unknown): value is IpcMessage;
export declare function validateJsonValue(value: unknown): value is JsonValue;
export declare function validateLanguage(value: unknown): value is Language;
export declare function validateLayoutTemplate(
  value: unknown,
): value is LayoutTemplate;
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
export declare function validateLineEnding(value: unknown): value is LineEnding;
export declare function validateMemoryBudget(
  value: unknown,
): value is MemoryBudget;
export declare function validateMessageFragment(
  value: unknown,
): value is MessageFragment;
export declare function validateMotion(value: unknown): value is Motion;
export declare function validateNetworkMode(
  value: unknown,
): value is NetworkMode;
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
export declare function validateOperationInput(
  value: unknown,
): value is OperationInput;
export declare function validateOperationInputParams(
  value: unknown,
): value is OperationInputParams;
export declare function validateOperationInputRedaction(
  value: unknown,
): value is OperationInputRedaction;
export declare function validateOperationResult(
  value: unknown,
): value is OperationResult;
export declare function validateOperationState(
  value: unknown,
): value is OperationState;
export declare function validateOperationSummary(
  value: unknown,
): value is OperationSummary;
export declare function validateOperationsSnapshot(
  value: unknown,
): value is OperationsSnapshot;
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
export declare function validateRadius(value: unknown): value is Radius;
export declare function validateRawBatch(value: unknown): value is RawBatch;
export declare function validateRawEvent(value: unknown): value is RawEvent;
export declare function validateRawPayload(value: unknown): value is RawPayload;
export declare function validateReaderGap(value: unknown): value is ReaderGap;
export declare function validateReaderGapReason(
  value: unknown,
): value is ReaderGapReason;
export declare function validateRebindParams(
  value: unknown,
): value is RebindParams;
export declare function validateRecentList(value: unknown): value is RecentList;
export declare function validateReconnectState(
  value: unknown,
): value is ReconnectState;
export declare function validateReconnectStatus(
  value: unknown,
): value is ReconnectStatus;
export declare function validateRecoverPrefixParams(
  value: unknown,
): value is RecoverPrefixParams;
export declare function validateRegisterFileParams(
  value: unknown,
): value is RegisterFileParams;
export declare function validateReplayControlParams(
  value: unknown,
): value is ReplayControlParams;
export declare function validateReplayOpenParams(
  value: unknown,
): value is ReplayOpenParams;
export declare function validateReplayReadParams(
  value: unknown,
): value is ReplayReadParams;
export declare function validateReplayReadResult(
  value: unknown,
): value is ReplayReadResult;
export declare function validateReplayRecord(
  value: unknown,
): value is ReplayRecord;
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
export declare function validateSessionInputs(
  value: unknown,
): value is SessionInputs;
export declare function validateSessionMetrics(
  value: unknown,
): value is SessionMetrics;
export declare function validateSessionSnapshot(
  value: unknown,
): value is SessionSnapshot;
export declare function validateSessionState(
  value: unknown,
): value is SessionState;
export declare function validateSetReadOnlyParams(
  value: unknown,
): value is SetReadOnlyParams;
export declare function validateSettingsDocumentResult(
  value: unknown,
): value is SettingsDocumentResult;
export declare function validateSettingsSaveParams(
  value: unknown,
): value is SettingsSaveParams;
export declare function validateSettingsSnapshot(
  value: unknown,
): value is SettingsSnapshot;
export declare function validateSharedSettings(
  value: unknown,
): value is SharedSettings;
export declare function validateShutdownMode(
  value: unknown,
): value is ShutdownMode;
export declare function validateShutdownReport(
  value: unknown,
): value is ShutdownReport;
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
export declare function validateStartupConfigSnapshot(
  value: unknown,
): value is StartupConfigSnapshot;
export declare function validateStartupConfigSource(
  value: unknown,
): value is StartupConfigSource;
export declare function validateStartupLogLevel(
  value: unknown,
): value is StartupLogLevel;
export declare function validateStartupProfileReference(
  value: unknown,
): value is StartupProfileReference;
export declare function validateStateScopeRef(
  value: unknown,
): value is StateScopeRef;
export declare function validateStateScopesResult(
  value: unknown,
): value is StateScopesResult;
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
export declare function validateStreamCursorResult(
  value: unknown,
): value is StreamCursorResult;
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
export declare function validateTerminalMode(
  value: unknown,
): value is TerminalMode;
export declare function validateTerminalSettings(
  value: unknown,
): value is TerminalSettings;
export declare function validateTerminalTypography(
  value: unknown,
): value is TerminalTypography;
export declare function validateTextExportParams(
  value: unknown,
): value is TextExportParams;
export declare function validateTheme(value: unknown): value is Theme;
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
export declare function validateVerificationReport(
  value: unknown,
): value is VerificationReport;
export declare function validateWaitBoundaryParams(
  value: unknown,
): value is WaitBoundaryParams;
export declare function validateWaitBoundaryReceipt(
  value: unknown,
): value is WaitBoundaryReceipt;
export declare function validateWireFrame(value: unknown): value is WireFrame;
export declare function validateWorkspaceDocument(
  value: unknown,
): value is WorkspaceDocument;
export declare function validateWorkspaceDocumentResult(
  value: unknown,
): value is WorkspaceDocumentResult;
export declare function validateWorkspaceSaveParams(
  value: unknown,
): value is WorkspaceSaveParams;
export declare function validateWorkspaceSnapshot(
  value: unknown,
): value is WorkspaceSnapshot;
export declare function validateWorkspaceView(
  value: unknown,
): value is WorkspaceView;
