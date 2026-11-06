import type { settingsDocument } from "./settings-model";
import type {
  DesktopStatus,
  DiagnosticsReport,
  ExtensionPermission,
  ExtensionConsent,
  ExtensionArtifact,
  ExtensionCredentialSlot,
  ExtensionFileChoice,
  ExtensionStorageInfo,
  ExtensionArchivePreview,
  ExtensionArchiveResult,
  ExtensionPreview,
  ExtensionRunInput,
  ExtensionRunStatus,
  ExtensionSnapshot,
  ExtensionService,
  ExtensionView,
  ExtensionViewInput,
  MarketDownload,
  MarketDownloadProgress,
  MarketSnapshot,
  MarketSource,
  NativeError as NativeFailure,
  SettingsSnapshot,
  UpdateProgress,
  UpdateStatus,
  WindowGeometry,
  Wallpaper,
  WallpaperInput,
  WallpaperVideo,
  WallpaperVideoChoice,
} from "./generated/bindings";

export type {
  ExtensionConsent,
  ExtensionOrigin,
  ExtensionArchivePreview,
  ExtensionArchiveResult,
  ExtensionArchiveStatus,
  ExtensionArtifact,
  ExtensionCredentialSlot,
  ExtensionFileChoice,
  ExtensionStorageInfo,
  ExtensionRunStatus,
  ExtensionViewRequest,
  ExtensionViewInput,
  ExtensionHostContext,
  ExtensionEffect,
  ExtensionEffectResult,
  MarketSource,
  MarketCatalog,
  MarketEntry,
  MarketIncompatibleEntry,
  MarketSnapshot,
  MarketDownload,
  MarketDownloadProgress,
  ExtensionCommand,
  ExtensionResultFormat,
  ExtensionPermission,
  ExtensionPreview,
  ExtensionInfo,
  ExtensionSnapshot,
  ExtensionService,
  ExtensionRunInput,
  ExtensionIcon,
  ExtensionView,
  ExtensionViewDataInput,
  ExtensionViewField,
  ExtensionViewBlock,
  DesktopStatus,
  DiagnosticsReport,
  FrontendError,
  SettingsSnapshot,
  UpdateProgress,
  UpdateStatus,
  WindowGeometry,
  Wallpaper,
  WallpaperInput,
  WallpaperVideo,
  WallpaperVideoChoice,
  WallpaperVideoMime,
} from "./generated/bindings";

export function extensionSnapshot(): Promise<ExtensionSnapshot> {
  return callNative((commands) => commands.extensionSnapshot());
}
export function extensionRunStatus(): Promise<ExtensionRunStatus[]> {
  return callNative((commands) => commands.extensionRunStatus());
}
export async function prepareEnabledExtensions(): Promise<void> {
  await callNative((commands) => commands.prepareEnabledExtensions());
}
export function previewExtensionArchive(): Promise<ExtensionArchivePreview> {
  return callNative((commands) => commands.previewExtensionArchive());
}
export function archiveLegacyExtensions(
  expectedSha256: string,
): Promise<ExtensionArchiveResult> {
  return callNative((commands) =>
    commands.archiveLegacyExtensions(expectedSha256),
  );
}
export function extensionMarketSnapshot(
  refresh = false,
): Promise<MarketSnapshot> {
  return callNative((commands) => commands.extensionMarketSnapshot(refresh));
}
export async function downloadMarketExtension(
  id: string,
  expectedPackageSha256: string,
  onProgress: (progress: MarketDownloadProgress) => void,
): Promise<MarketDownload> {
  return callNative(async (commands) => {
    const { Channel } = await import("@tauri-apps/api/core");
    const progress = new Channel<MarketDownloadProgress>(onProgress);
    try {
      return await commands.downloadMarketExtension(
        id,
        expectedPackageSha256,
        progress,
      );
    } finally {
      progress.onmessage = () => {};
    }
  });
}
export function previewExtension(content: string): Promise<ExtensionPreview> {
  return callNative((commands) => commands.previewExtension(content));
}
export function viewExtension(
  input: ExtensionViewInput,
): Promise<ExtensionView> {
  return callNative((commands) => commands.viewExtension(input));
}
export async function requestExtensionService(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
  service: ExtensionService,
  request: Record<string, unknown>,
): Promise<unknown> {
  const result = await callNative((commands) =>
    commands.requestExtensionService(
      id,
      expectedSha256,
      expectedGeneration,
      service,
      JSON.stringify(request),
    ),
  );
  return JSON.parse(result) as unknown;
}
export async function openExtensionCenter(): Promise<void> {
  await callNative((commands) => commands.openExtensionCenter());
}
export async function openExtensionUi(
  id: string,
  commandId: string,
  expectedSha256: string,
  expectedGeneration: number,
): Promise<{ token: string; url: string }> {
  const token = await callNative((commands) =>
    commands.openExtensionUi(id, commandId, expectedSha256, expectedGeneration),
  );
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return { token, url: convertFileSrc(token, "extension-ui") };
}
export async function closeExtensionUi(token: string): Promise<void> {
  await callNative((commands) => commands.closeExtensionUi(token));
}
export async function openExtensionWindow(
  id: string,
  commandId: string,
  expectedSha256: string,
  expectedGeneration: number,
): Promise<void> {
  await callNative((commands) =>
    commands.openExtensionWindow(
      id,
      commandId,
      expectedSha256,
      expectedGeneration,
    ),
  );
}
export function installExtension(
  content: string,
  expectedRevision: number,
  replaceExisting: boolean,
  expectedSha256: string,
  consent?: ExtensionConsent,
): Promise<ExtensionSnapshot> {
  return callNative((commands) =>
    commands.installExtension(
      content,
      expectedRevision,
      replaceExisting,
      expectedSha256,
      consent ?? null,
    ),
  );
}
export function setExtensionEnabled(
  id: string,
  enabled: boolean,
  grants: ExtensionPermission[],
  expectedRevision: number,
  trusted: boolean,
): Promise<ExtensionSnapshot> {
  return callNative((commands) =>
    commands.setExtensionEnabled(
      id,
      enabled,
      grants,
      expectedRevision,
      trusted,
    ),
  );
}
export function installMarketExtension(
  content: string,
  expectedRevision: number,
  replaceExisting: boolean,
  expectedSha256: string,
  source: MarketSource,
  consent?: ExtensionConsent,
): Promise<ExtensionSnapshot> {
  return callNative((commands) =>
    commands.installMarketExtension(
      content,
      expectedRevision,
      replaceExisting,
      expectedSha256,
      source,
      consent ?? null,
    ),
  );
}
export function rollbackExtension(
  id: string,
  expectedRevision: number,
): Promise<ExtensionSnapshot> {
  return callNative((commands) =>
    commands.rollbackExtension(id, expectedRevision),
  );
}
export function pickExtensionFiles(): Promise<ExtensionFileChoice[]> {
  return callNative((commands) => commands.pickExtensionFiles());
}
export function validateExtensionView(content: string): Promise<ExtensionView> {
  return callNative((commands) => commands.validateExtensionView(content));
}
export function saveExtensionArtifact(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
  artifact: ExtensionArtifact,
): Promise<string | null> {
  return callNative((commands) =>
    commands.saveExtensionArtifact(
      id,
      expectedSha256,
      expectedGeneration,
      artifact,
    ),
  );
}
export function extensionStorageInfo(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
): Promise<ExtensionStorageInfo> {
  return callNative((commands) =>
    commands.extensionStorageInfo(id, expectedSha256, expectedGeneration),
  );
}
export function clearExtensionStorage(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
  expectedRevision: number,
): Promise<void> {
  return callNative((commands) =>
    commands.clearExtensionStorage(
      id,
      expectedSha256,
      expectedGeneration,
      expectedRevision,
    ),
  ).then(() => undefined);
}
export function extensionCredentialSlots(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
): Promise<ExtensionCredentialSlot[]> {
  return callNative((commands) =>
    commands.extensionCredentialSlots(id, expectedSha256, expectedGeneration),
  );
}
export function setExtensionCredential(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
  origin: string,
  alias: string,
  secret: string,
): Promise<void> {
  return callNative((commands) =>
    commands.setExtensionCredential(
      id,
      expectedSha256,
      expectedGeneration,
      origin,
      alias,
      secret,
    ),
  ).then(() => undefined);
}
export function deleteExtensionCredential(
  id: string,
  expectedSha256: string,
  expectedGeneration: number,
  origin: string,
  alias: string,
): Promise<void> {
  return callNative((commands) =>
    commands.deleteExtensionCredential(
      id,
      expectedSha256,
      expectedGeneration,
      origin,
      alias,
    ),
  ).then(() => undefined);
}
export function uninstallExtension(
  id: string,
  expectedRevision: number,
): Promise<ExtensionSnapshot> {
  return callNative((commands) =>
    commands.uninstallExtension(id, expectedRevision),
  );
}
export function runExtension(input: ExtensionRunInput): Promise<string> {
  return callNative((commands) => commands.runExtension(input));
}
export async function cancelExtension(
  id: string,
  expectedGeneration: number,
): Promise<void> {
  await callNative((commands) =>
    commands.cancelExtension(id, expectedGeneration),
  );
}
export function onExtensionsChanged(handler: () => void): Promise<() => void> {
  return onNativeEvent("app://extensions-changed", handler);
}

export function listWallpapers(
  legacy: WallpaperInput | null = null,
): Promise<Wallpaper[]> {
  return callNative((commands) => commands.listWallpapers(legacy));
}
export function addWallpaper(input: WallpaperInput): Promise<Wallpaper> {
  return callNative((commands) => commands.addWallpaper(input));
}
export function chooseWallpaperVideo(): Promise<WallpaperVideoChoice | null> {
  return callNative((commands) => commands.chooseWallpaperVideo());
}
export async function wallpaperVideoUrl(
  video: WallpaperVideo,
): Promise<string> {
  requireDesktop();
  if (
    !/^[a-f0-9]{64}$/.test(video.id) ||
    !["video/mp4", "video/webm"].includes(video.mime)
  ) {
    throw new NativeBridgeError({
      code: "INVALID_ARGUMENT",
      message: "Invalid wallpaper video reference",
      retryable: false,
    });
  }
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(
    `${video.id}.${video.mime === "video/mp4" ? "mp4" : "webm"}`,
    "wallpaper-media",
  );
}
export function renameWallpaper(id: string, name: string): Promise<Wallpaper> {
  return callNative((commands) => commands.renameWallpaper(id, name));
}
export async function removeWallpaper(id: string): Promise<void> {
  await callNative((commands) => commands.removeWallpaper(id));
}
export function onWallpapersChanged(handler: () => void): Promise<() => void> {
  return onNativeEvent("app://wallpapers-changed", handler);
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

/** 会话按完整输入与结果的 JSON 转义预算保存，浏览器仍只发起本地下载。 */
export async function saveExtensionSession(
  name: string,
  content: string,
): Promise<string | null> {
  if (isTauri())
    return callNative((commands) =>
      commands.saveExtensionSession(name, content),
    );
  return saveTextExport(name, content);
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

export function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  return callNative((commands) => commands.loadSettingsSnapshot());
}

export function saveSettingsSnapshot(
  settings: ReturnType<typeof settingsDocument>,
  expectedRevision: number,
): Promise<SettingsSnapshot> {
  const document = structuredClone(settings);
  return callNative((commands) =>
    commands.saveSettingsSnapshot(document, expectedRevision),
  );
}

/** 显式恢复默认值独立于普通保存，允许用户确认后替换未来版本存档。 */
export function resetSettingsSnapshot(
  settings: ReturnType<typeof settingsDocument>,
  expectedRevision: number,
): Promise<SettingsSnapshot> {
  const document = structuredClone(settings);
  return callNative((commands) =>
    commands.resetSettingsSnapshot(document, expectedRevision),
  );
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

export function onSettingsChanged(
  handler: (snapshot: SettingsSnapshot) => void,
): Promise<() => void> {
  return onNativeEvent("app://settings-changed", handler);
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
