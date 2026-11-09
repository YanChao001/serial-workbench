// Host errors preserve Core codes independently of the desktop system error enum.
import {
  ContractValidationError,
  parseReply,
} from "@serial-workbench/contracts";
import type {
  HostError,
  ObjectRef,
  OpenParams,
  Query,
  RawBatch,
  RpcReply,
  RpcRequest,
  WireFrame,
  SessionSnapshot,
  U64,
  Operation,
} from "@serial-workbench/contracts";
import type { DesktopAttachment, DeliveryStream } from "./generated/bindings";
import { HostRequestError } from "@serial-workbench/host-client";
import type {
  DesktopStatus,
  ClientStateSnapshot_Serialize as ClientStateSnapshot,
  ClientWindowState_Deserialize as ClientWindowStateInput,
  HostSettingsEffectsReceipt,
  DiagnosticsReport,
  NativeError as NativeFailure,
  UpdateProgress,
  UpdateStatus,
  WindowGeometry,
  FileResourceRole,
  CaptureNameHint,
  SelectedFileResource,
  MediaResolution,
  LocalDocumentIntent_Deserialize,
} from "./generated/bindings";

export type {
  ClientPreferences,
  ClientStateSnapshot_Serialize as ClientStateSnapshot,
  ClientWindowState_Serialize as ClientWindowState,
  ClientWindowState_Deserialize as ClientWindowStateInput,
  HostSettingsEffectsReceipt,
  DesktopStatus,
  DiagnosticsReport,
  FrontendError,
  UpdateProgress,
  UpdateStatus,
  WindowGeometry,
  FileResourceRole,
  CaptureNameHint,
  SelectedFileResource,
  MediaResolution,
} from "./generated/bindings";

export function readClientState(): Promise<ClientStateSnapshot> {
  return callNative((commands) => commands.clientStateRead());
}
export function saveClientState(
  state: ClientWindowStateInput,
  expectedRevision: U64,
): Promise<ClientStateSnapshot> {
  return callNative((commands) =>
    commands.clientStateSave(state, expectedRevision),
  );
}
export function applyHostSettingsEffects(): Promise<HostSettingsEffectsReceipt> {
  return callHost((commands) => commands.applyHostSettingsEffects());
}
export function chooseFileResource(
  role: FileResourceRole,
  generation: U64,
  captureNameHint?: CaptureNameHint,
): Promise<SelectedFileResource | null> {
  return callHost((commands) =>
    commands.chooseFileResource(role, generation, captureNameHint ?? null),
  );
}
export function mediaResolve(
  reference: ObjectRef,
  generation: U64,
): Promise<MediaResolution> {
  return callHost((commands) => commands.mediaResolve(reference, generation));
}
export async function mediaRelease(
  ticket: string,
  generation: U64,
): Promise<void> {
  await callHost((commands) => commands.mediaRelease(ticket, generation));
}
export function hostConnectDevice(
  generation: U64,
  deviceId: string,
  params: OpenParams,
): Promise<SessionSnapshot> {
  return callHost((commands) =>
    commands.hostConnectDevice(generation, deviceId, params),
  );
}

export async function hostApplyDocumentIntent(
  generation: U64,
  intent: LocalDocumentIntent_Deserialize,
): Promise<Operation> {
  const operation = await callHost((commands) =>
    commands.hostApplyDocumentIntent(generation, intent),
  );
  const reply = parseReply({ ok: true, result: { operation } });
  if (!reply.ok || !("operation" in reply.result))
    throw new ContractValidationError();
  return reply.result.operation;
}

export class NativeBridgeError extends Error {
  readonly code: NativeFailure["code"];
  readonly retryable: boolean;

  constructor(failure: NativeFailure) {
    super(failure.message);
    this.name = "NativeBridgeError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

type NativeCommands = (typeof import("./generated/bindings"))["commands"];

async function callNative<T>(
  call: (
    commands: NativeCommands,
  ) => Promise<
    { status: "ok"; data: T } | { status: "error"; error: NativeFailure }
  >,
): Promise<T> {
  if (!isTauri())
    throw new NativeBridgeError({
      code: "PLATFORM_UNAVAILABLE",
      message: "Start the desktop app with pnpm app:dev to use this feature.",
      retryable: false,
    });
  const { commands } = await import("./generated/bindings");
  const result = await call(commands);
  if (result.status === "error") throw new NativeBridgeError(result.error);
  return result.data;
}

/**
 * 系统能力的唯一出口。
 *
 * 手写应用代码只在此文件 import `@tauri-apps/*`；生成绑定是底层例外。
 * ESLint 同时检查静态与动态导入。
 * 页面、组件、hooks 只调用这里导出的函数，不直接碰 Tauri API。
 */

/** 判断当前是否运行在 Tauri 窗口里（而非普通浏览器预览）。 */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 原生通过系统对话框保存；浏览器仅发起本地文件下载。取消保存不算成功。 */
export async function saveTextExport(
  name: string,
  content: string,
): Promise<string | null> {
  if (isTauri())
    return callNative((commands) => commands.saveTextExport(name, content));
  const url = URL.createObjectURL(
    new Blob([content], {
      type: name.endsWith(".json")
        ? "application/json;charset=utf-8"
        : "text/plain;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 下载导航异步消费 URL；延后释放，避免点击后立刻撤销导致空下载。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** 用系统默认浏览器打开外链；在浏览器预览时退化为新标签页。 */
export async function openExternal(url: string): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("只允许打开 http(s) 外链");
  }
  if (!isTauri()) {
    // noopener 即使成功打开也会返回 null，不能用返回值判断弹窗是否被拦截
    window.open(target.href, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(target.href);
}

/** 通知 Rust 当前窗口首帧已完成，再显示并聚焦该窗口。 */
export async function revealWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await callNative((commands) => commands.completeFrontendStartup());
  } catch (error) {
    // 这里不抛：窗口没能显示时 Rust 侧的 3 秒兜底仍会生效
    console.error("显示窗口失败", error);
  }
}

/** 最小化主窗口。 */
export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

/** 在最大化与还原之间切换，返回切换后的状态。 */
export async function toggleMaximizeWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window_ = getCurrentWindow();
  await window_.toggleMaximize();
  return window_.isMaximized();
}

/** 关闭主窗口。 */
export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/** 读取主窗口是否最大化。 */
export async function isWindowMaximized(): Promise<boolean> {
  if (!isTauri()) return false;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isMaximized();
}

export async function isWindowFullscreen(): Promise<boolean> {
  if (!isTauri()) return !!document.fullscreenElement;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isFullscreen();
}

/** 浏览器采用真实 Fullscreen API；拒绝或不支持时由调用方显示错误。 */
export async function setWindowFullscreen(fullscreen: boolean): Promise<void> {
  if (!isTauri()) {
    if (fullscreen) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setFullscreen(fullscreen);
}

/** 订阅窗口尺寸变化，返回取消订阅函数。 */
export async function onWindowResized(
  handler: () => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onResized(handler);
}

/** 订阅窗口移动，用于刷新当前显示器的尺寸约束。 */
export async function onWindowMoved(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onMoved(handler);
}

/** 读取当前窗口的正常尺寸和当前显示器允许的逻辑像素范围。 */
export function getWindowGeometry(): Promise<WindowGeometry> {
  return callNative((commands) => commands.getWindowGeometry());
}

/** 应用并持久化当前窗口尺寸，最大化或全屏时先还原。 */
export function setWindowSize(
  width: number,
  height: number,
): Promise<WindowGeometry> {
  return callNative((commands) => commands.setWindowSize(width, height));
}

/** 恢复所有窗口的配置默认尺寸，可同时将窗口移至各自显示器中央。 */
export function resetWindowGeometry(center = false): Promise<WindowGeometry> {
  return callNative((commands) => commands.resetWindowGeometry(center));
}

export type AppInfo = {
  /** 应用版本，来源是 tauri.conf.json */
  version: string;
  /** Tauri 运行时版本 */
  tauriVersion: string;
};

/** 读取应用与运行时版本，浏览器预览下不可用。 */
export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauri()) {
    throw new Error("浏览器预览模式下无法读取运行时信息");
  }
  const app = await import("@tauri-apps/api/app");
  const [version, tauriVersion] = await Promise.all([
    app.getVersion(),
    app.getTauriVersion(),
  ]);
  return { version, tauriVersion };
}

async function onNativeEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const [{ listen }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/window"),
  ]);
  // 默认 Any 会接收发给其他窗口的事件；广播仍会匹配此窗口目标。
  return listen<T>(event, ({ payload }) => handler(payload), {
    target: { kind: "WebviewWindow", label: getCurrentWindow().label },
  });
}

export function onUpdateProgress(
  handler: (progress: UpdateProgress) => void,
): Promise<() => void> {
  return onNativeEvent("app://update-progress", handler);
}

export async function openSecondaryWindow(): Promise<void> {
  await callNative((commands) => commands.openSecondaryWindow());
}

export function getDesktopStatus(): Promise<DesktopStatus> {
  return callNative((commands) => commands.getDesktopStatus());
}

export function getAutostartEnabled(): Promise<boolean> {
  return callNative((commands) => commands.getAutostartEnabled());
}

export function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  return callNative((commands) => commands.setAutostartEnabled(enabled));
}

function diagnosticText(value: string, limit: number): string {
  // encodeInto 的 read 以 UTF-16 计数，且不会在 UTF-8 字符中间截断。
  const { read } = new TextEncoder().encodeInto(value, new Uint8Array(limit));
  return value.slice(0, read);
}

export async function recordFrontendError(error: {
  message: string;
  stack?: string;
  componentStack?: string;
}): Promise<void> {
  if (!isTauri()) return;
  await callNative((commands) =>
    commands.recordFrontendError({
      message: diagnosticText(error.message, 4096),
      stack: error.stack ? diagnosticText(error.stack, 8192) : null,
      componentStack: error.componentStack
        ? diagnosticText(error.componentStack, 8192)
        : null,
    }),
  );
}

export function getDiagnosticsReport(): Promise<DiagnosticsReport> {
  return callNative((commands) => commands.getDiagnosticsReport());
}

export function checkForUpdate(): Promise<UpdateStatus> {
  return callNative((commands) => commands.checkForUpdate());
}

export function getUpdateSnapshot(): Promise<UpdateProgress | null> {
  return callNative((commands) => commands.getUpdateSnapshot());
}

export async function downloadAndInstallUpdate(): Promise<void> {
  await callNative((commands) => commands.downloadAndInstallUpdate());
}

export async function relaunchApp(): Promise<void> {
  await callNative((commands) => commands.relaunchApp());
}

export async function quitApp(): Promise<void> {
  await callNative((commands) => commands.quitApp());
}

export async function getCurrentWindowLabel(): Promise<string> {
  if (!isTauri()) return "browser";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

export type {
  LifecycleAction,
  LifecycleRequest,
  Activation,
  Workspace,
} from "./generated/bindings";

export async function setWindowWorkState(names: string[]): Promise<void> {
  await callNative((c) => c.setWindowWorkState(names));
}
export async function respondLifecycle(
  id: number,
  approved: boolean,
): Promise<void> {
  await callNative((c) => c.respondLifecycle(id, approved));
}
export function onLifecycleRequest(
  handler: (request: import("./generated/bindings").LifecycleRequest) => void,
): Promise<() => void> {
  return onNativeEvent("app://lifecycle-request", handler);
}
export function onLifecycleFinished(
  handler: (id: number) => void,
): Promise<() => void> {
  return onNativeEvent("app://lifecycle-finished", handler);
}
export function onLifecycleExecuting(
  handler: (id: number) => void,
): Promise<() => void> {
  return onNativeEvent("app://lifecycle-executing", handler);
}
export function getActivationSnapshot(): Promise<
  import("./generated/bindings").Activation[]
> {
  return callNative((c) => c.activationSnapshot());
}
export function onActivation(
  handler: (value: import("./generated/bindings").Activation) => void,
): Promise<() => void> {
  return onNativeEvent("app://activation", handler);
}
export function onWorkspaceRoute(
  handler: (route: string) => void,
): Promise<() => void> {
  return onNativeEvent("app://workspace-route", handler);
}
export function getWorkspace(): Promise<
  import("./generated/bindings").Workspace
> {
  return callNative((c) => c.getWorkspace());
}
export async function saveWorkspaceRoute(route: string): Promise<void> {
  await callNative((c) => c.saveWorkspaceRoute(route));
}
export async function restoreWorkspace(): Promise<void> {
  await callNative((c) => c.restoreWorkspace());
}
function requireDesktop(): void {
  if (!isTauri())
    throw new NativeBridgeError({
      code: "PLATFORM_UNAVAILABLE",
      message: "This action requires the desktop application.",
      retryable: false,
    });
}

export type { RecoveryStatus } from "./generated/bindings";
export function recoveryStatus(): Promise<
  import("./generated/bindings").RecoveryStatus
> {
  return callNative((c) => c.recoveryStatus());
}
export function stageRecovery(): Promise<
  import("./generated/bindings").RecoveryStatus
> {
  return callNative((c) => c.stageRecovery());
}
export async function writeSystemClipboard(text: string): Promise<void> {
  requireDesktop();
  const clipboard = await import("@tauri-apps/plugin-clipboard-manager");
  await clipboard.writeText(text);
}
export async function readSystemClipboard(): Promise<string> {
  requireDesktop();
  const clipboard = await import("@tauri-apps/plugin-clipboard-manager");
  return clipboard.readText();
}
export async function sendSystemNotification(
  title: string,
  body: string,
  requestPermission = true,
): Promise<boolean> {
  requireDesktop();
  const notification = await import("@tauri-apps/plugin-notification");
  let granted = await notification.isPermissionGranted();
  if (!granted && requestPermission)
    granted = (await notification.requestPermission()) === "granted";
  if (granted) notification.sendNotification({ title, body });
  return granted;
}
export async function onSystemNotification(
  handler: () => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const notification = await import("@tauri-apps/plugin-notification");
  const listener = await notification.onAction(handler);
  return () => {
    void listener.unregister();
  };
}

async function callHost<T>(
  call: (
    commands: NativeCommands,
  ) => Promise<
    { status: "ok"; data: T } | { status: "error"; error: HostError }
  >,
): Promise<T> {
  requireDesktop();
  const { commands } = await import("./generated/bindings");
  const result = await call(commands);
  if (result.status === "error") throw new HostRequestError(result.error);
  return result.data;
}
export function hostAttachment(): Promise<DesktopAttachment> {
  return callHost((commands) => commands.hostAttachment());
}
export function hostRequest(request: RpcRequest): Promise<RpcReply> {
  return callHost((commands) => commands.hostRequest(request));
}
export function hostRawRequest(request: RpcRequest): Promise<RpcReply> {
  return callHost((commands) => commands.hostRawRequest(request));
}
export async function hostSubscribe(
  request: Query,
  onFrame: (frame: WireFrame) => void,
): Promise<string> {
  requireDesktop();
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<WireFrame>(onFrame);
  return callHost((commands) => commands.hostSubscribe(request, channel));
}
export async function hostRawSubscribe(
  request: Query,
  onBatch: (batch: RawBatch) => void,
  onLifecycle: (frame: WireFrame) => void,
): Promise<string> {
  requireDesktop();
  const { Channel } = await import("@tauri-apps/api/core");
  return callHost((commands) =>
    commands.hostRawSubscribe(
      request,
      new Channel<RawBatch>(onBatch),
      new Channel<WireFrame>(onLifecycle),
    ),
  );
}
export async function hostUnsubscribe(subscriptionId: string): Promise<void> {
  await callHost((commands) => commands.hostUnsubscribe(subscriptionId));
}
export async function hostRawUnsubscribe(
  subscriptionId: string,
): Promise<void> {
  await callHost((commands) => commands.hostRawUnsubscribe(subscriptionId));
}
export async function hostDeliveryAck(
  generation: U64,
  subscriptionId: string,
  stream: DeliveryStream,
  ordinal: U64,
): Promise<void> {
  await callHost((commands) =>
    commands.hostDeliveryAck(generation, subscriptionId, stream, ordinal),
  );
}
