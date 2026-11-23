import {
  useContext,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTheme } from "next-themes";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  StreamItem,
  TerminalTypography,
  TextEncoding,
} from "@serial-workbench/contracts";
import { defaults } from "@serial-workbench/contracts";
import { matchesShortcut } from "@/commands/shortcuts";
import { commandAvailable } from "@/commands/types";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/external-link";
import { Switch } from "@/components/ui/switch";
import { useOpenExternal } from "@/hooks/use-external-links";
import { useTextEncoding } from "@/hooks/use-text-encoding";
import { isMacOS } from "@/lib/platform";
import { saveTextExport } from "@/lib/tauri";
import { createTextDecoder } from "@/lib/text-encoding";
import { CommandsContext } from "@/providers/commands-context";
import type { WorkbenchLabels } from "./labels";
import { ansiReceiveTail, type AnsiReceive } from "./ansi-receive";
import { ANSI_PALETTES, ansiColorSnapshot } from "./ansi-colors";
import {
  createAnsiKeyboardWriter,
  encodeAnsiKey,
  type AnsiKeyboardTarget,
} from "./ansi-keyboard";
import { ansiLinkUrl, createAnsiLinkIndex } from "./ansi-links";
import { bindAnsiMouse, selectsAnsiText } from "./ansi-mouse";
import { observeAnsiHistory, type AnsiHistorySnapshot } from "./ansi-history";
import { AnsiHistoryControls } from "./ansi-history-controls";
import { AnsiSearchControls } from "./ansi-search-controls";
import { AnsiShellControls } from "./ansi-shell-controls";
import { decodeBytes } from "./stream-model";
import { terminalTypographyStyle } from "./stream-presentation";
import { useAnsiPaste } from "./use-ansi-paste";

const WRITE_BATCH_BYTES = 64 * 1024;

function joinOperatorRuns(text: string): [number, number][] {
  return Array.from(text.matchAll(/[!#%&*+./:;<=>?^|~-]{2,}/g), (match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

type Projection = {
  terminal: Terminal;
  fit: FitAddon;
  decoder: ReturnType<typeof createTextDecoder>;
  observer: ResizeObserver;
  wanted: readonly AnsiReceive[];
  offset: number;
  writing: boolean;
  disposed: boolean;
  encoding: TextEncoding;
  convertEol: boolean;
  scrollback: number;
  typography?: TerminalTypography;
  ligatureJoiner?: number;
  disposeMouse?: () => void;
  disposeHistory?: () => void;
};

function project(
  element: HTMLDivElement,
  encoding: TextEncoding,
  convertEol: boolean,
  palette: ITheme,
  scrollback: number,
): Projection {
  const terminal = new Terminal({
    allowProposedApi: true,
    disableStdin: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    screenReaderMode: true,
    convertEol,
    scrollback,
    windowOptions: { setWinSizeChars: false },
    cursorInactiveStyle: "none",
    theme: palette,
  });
  // Device-originated OSC 52 cannot access the system clipboard.
  terminal.parser.registerOscHandler(52, () => true);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(element);
  return {
    terminal,
    fit,
    decoder: createTextDecoder(encoding),
    observer,
    wanted: [],
    offset: 0,
    writing: false,
    disposed: false,
    encoding,
    convertEol,
    scrollback,
  };
}

function dispose(projection: Projection | null) {
  if (!projection) return;
  projection.disposed = true;
  projection.observer.disconnect();
  projection.disposeMouse?.();
  projection.disposeHistory?.();
  projection.terminal.dispose();
}

/** Keep at most one write queued. If the source changes, dispose its parser. */
function drain(projection: Projection) {
  if (
    projection.disposed ||
    projection.writing ||
    projection.offset >= projection.wanted.length
  )
    return;

  const chunks: string[] = [];
  let size = 0;
  while (
    projection.offset < projection.wanted.length &&
    size < WRITE_BATCH_BYTES
  ) {
    const packet = projection.wanted[projection.offset]!;
    const bytes = decodeBytes(packet.payload.bytesBase64);
    chunks.push(projection.decoder.decode(bytes, { stream: true }));
    projection.offset += 1;
    size += bytes.length;
  }
  projection.writing = true;
  projection.terminal.write(chunks.join(""), () => {
    projection.writing = false;
    drain(projection);
  });
}

export default function AnsiScreen({
  items,
  encoding,
  convertEol,
  sendEncoding,
  keyboard,
  typography = defaults.terminalTypography,
  scrollback,
  onScrollbackChange,
  rawTrimmed,
  labels,
}: {
  items: readonly StreamItem[];
  encoding: TextEncoding;
  convertEol: boolean;
  sendEncoding: TextEncoding;
  keyboard?: AnsiKeyboardTarget;
  typography?: TerminalTypography;
  scrollback: number;
  onScrollbackChange?: (value: number) => void;
  rawTrimmed?: boolean;
  labels: WorkbenchLabels;
}) {
  const element = useRef<HTMLDivElement>(null);
  const keyboardSwitch = useRef<HTMLButtonElement>(null);
  const pasteConfirmation = useRef<HTMLDivElement>(null);
  const active = useRef<Projection | null>(null);
  const savingSnapshot = useRef(false);
  const [snapshotStatus, setSnapshotStatus] = useState<
    { kind: "saving" } | { kind: "error"; projection: Projection } | undefined
  >();
  const status = useTextEncoding(encoding);
  const sendStatus = useTextEncoding(sendEncoding);
  const commands = useContext(CommandsContext);
  const openExternal = useOpenExternal();
  const [linkIndex] = useState(createAnsiLinkIndex);
  const links = useSyncExternalStore(linkIndex.subscribe, linkIndex.snapshot);
  const [history, setHistory] = useState<{
    terminal: Terminal;
    snapshot: AnsiHistorySnapshot;
  }>();
  function jumpToLine(line: number | "latest") {
    const terminal = active.current?.terminal;
    if (!terminal) return;
    if (line === "latest") terminal.scrollToBottom();
    else if (line >= 1 && line <= terminal.buffer.active.length)
      terminal.scrollToLine(line - 1);
  }
  async function exportSnapshot() {
    const projection = active.current;
    const root = element.current;
    if (!projection || !root || savingSnapshot.current) return;
    savingSnapshot.current = true;
    setSnapshotStatus({ kind: "saving" });
    try {
      const content = ansiColorSnapshot(root);
      if (content === undefined)
        throw new Error("ANSI viewport is unavailable");
      await saveTextExport("serial-workbench-ansi-screen.txt", content);
      setSnapshotStatus(undefined);
    } catch {
      setSnapshotStatus(
        active.current === projection
          ? { kind: "error", projection }
          : undefined,
      );
    } finally {
      savingSnapshot.current = false;
    }
  }
  const writer = useRef<ReturnType<typeof createAnsiKeyboardWriter> | null>(
    null,
  );
  const [armed, setArmed] = useState<string | null>(null);
  const [mouseArmed, setMouseArmed] = useState<string | null>(null);
  const [sizeArmed, setSizeArmed] = useState<string | null>(null);
  const [failure, setFailure] = useState<
    "encoding" | "overflow" | "operation" | null
  >(null);
  const keyboardScope =
    keyboard && sendStatus === "ready" && status === "ready"
      ? JSON.stringify([keyboard.scope, sendEncoding])
      : null;
  const enabled = armed !== null && armed === keyboardScope;
  if (armed !== null && !enabled) setArmed(null);
  const mouseEnabled = enabled && mouseArmed === keyboardScope;
  if (mouseArmed !== null && !mouseEnabled) setMouseArmed(null);
  const sizeReportEnabled = enabled && sizeArmed === keyboardScope;
  if (sizeArmed !== null && !sizeReportEnabled) setSizeArmed(null);
  const paste = useAnsiPaste(
    enabled && keyboard?.paste ? keyboardScope : null,
    keyboard?.paste,
    sendEncoding,
  );
  const hasPastePreview = !!paste.preview;
  const pasteBlocksKeys = hasPastePreview || paste.busy;
  const { resolvedTheme } = useTheme();
  const palette =
    resolvedTheme === "dark" ? ANSI_PALETTES.dark : ANSI_PALETTES.light;
  const packets = useMemo(() => ansiReceiveTail(items), [items]);

  const sendBatch = useEffectEvent(
    (scope: string, bytes: Uint8Array, signal: AbortSignal) => {
      if (!enabled || scope !== keyboardScope || !keyboard)
        throw new Error("Terminal keyboard scope has changed");
      return keyboard.send(bytes, signal);
    },
  );
  const acceptsKey = useEffectEvent(
    (terminal: Terminal, event: KeyboardEvent) => {
      if (
        !enabled ||
        !event.isTrusted ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.target !== terminal.textarea ||
        terminal.textarea?.ownerDocument.activeElement !== terminal.textarea ||
        event.metaKey
      )
        return false;
      if (event.key === "Tab" && event.shiftKey) {
        if (event.type === "keydown" && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          keyboardSwitch.current?.focus();
        }
        return false;
      }
      if (
        !isMacOS() &&
        terminal.hasSelection() &&
        event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "c"
      )
        return false;
      if (
        pasteBlocksKeys ||
        (keyboard?.paste &&
          !isMacOS() &&
          event.ctrlKey &&
          !event.altKey &&
          event.key.toLowerCase() === "v")
      )
        return false;
      return !commands?.commands.some(
        (command) =>
          commandAvailable(command) &&
          command.shortcuts?.some((shortcut) =>
            matchesShortcut(event, shortcut),
          ),
      );
    },
  );
  const receiveKey = useEffectEvent((value: string, event: KeyboardEvent) => {
    if (!writer.current || !event.isTrusted) return;
    try {
      writer.current.enqueue(encodeAnsiKey(value, event, sendEncoding));
    } catch {
      setFailure("encoding");
    }
  });
  const acceptsMouse = useEffectEvent(
    () => mouseEnabled && !pasteBlocksKeys && writer.current !== null,
  );
  const receiveMouse = useEffectEvent((bytes: Uint8Array) => {
    writer.current?.enqueue(bytes);
  });
  const reportWindowSize = useEffectEvent(
    (terminal: Terminal, { rows, cols }: { rows: number; cols: number }) => {
      if (
        sizeReportEnabled &&
        !pasteBlocksKeys &&
        active.current?.terminal === terminal
      )
        writer.current?.reportWindowSize(rows, cols);
    },
  );
  const activateLink = useEffectEvent(
    (terminal: Terminal, event: MouseEvent, uri: string) => {
      if (
        active.current?.terminal !== terminal ||
        !event.isTrusted ||
        (event.button !== 0 && event.button !== 1) ||
        selectsAnsiText(event) ||
        (mouseEnabled && terminal.modes.mouseTrackingMode !== "none")
      )
        return;
      const href = ansiLinkUrl(uri);
      if (href) {
        event.preventDefault();
        openExternal(href);
      }
    },
  );
  function guardLinkActivation(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (
      !event.nativeEvent.isTrusted ||
      !linkIndex.snapshot().includes(event.currentTarget.href)
    )
      event.preventDefault();
  }

  useLayoutEffect(() => {
    if (!enabled || !keyboardScope || pasteBlocksKeys) return;
    const current = createAnsiKeyboardWriter(
      (bytes, signal) => sendBatch(keyboardScope, bytes, signal),
      (reason) => {
        setFailure(reason);
        setArmed(null);
      },
    );
    writer.current = current;
    return () => {
      current.cancel();
      writer.current = null;
    };
  }, [enabled, keyboardScope, pasteBlocksKeys]);

  useLayoutEffect(
    () => () => {
      dispose(active.current);
      active.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    if (hasPastePreview) pasteConfirmation.current?.focus();
  }, [hasPastePreview]);
  useLayoutEffect(() => {
    if (!sizeReportEnabled) writer.current?.clearWindowSize();
    if (status !== "ready" || !element.current) {
      dispose(active.current);
      active.current = null;
      linkIndex.clear();
      return;
    }
    Terminal.strings.promptLabel = labels.ansiScreen;
    Terminal.strings.tooMuchOutput = labels.ansiScreenBusy;
    let screen = active.current;
    if (
      !screen ||
      screen.encoding !== encoding ||
      screen.convertEol !== convertEol ||
      screen.scrollback !== scrollback ||
      !screen.wanted.every((packet, index) => packet === packets[index])
    ) {
      const previousInput = screen?.terminal.textarea;
      const restoreFocus =
        enabled &&
        !!previousInput &&
        previousInput.ownerDocument.activeElement === previousInput;
      dispose(screen);
      linkIndex.clear();
      screen = project(
        element.current,
        encoding,
        convertEol,
        palette,
        scrollback,
      );
      active.current = screen;
      const terminal = screen.terminal;
      screen.disposeHistory = observeAnsiHistory(terminal, (snapshot) => {
        if (active.current?.terminal === terminal)
          setHistory({ terminal, snapshot });
      });
      terminal.options.linkHandler = {
        activate: (event, uri) => activateLink(terminal, event, uri),
        allowNonHttpProtocols: false,
      };
      terminal.parser.registerOscHandler(8, (data) => {
        if (active.current?.terminal === terminal) linkIndex.addOsc(data);
        return false;
      });
      terminal.attachCustomKeyEventHandler((event) =>
        acceptsKey(terminal, event),
      );
      terminal.onKey(({ key, domEvent }) => receiveKey(key, domEvent));
      terminal.onResize((size) => reportWindowSize(terminal, size));
      screen.disposeMouse = bindAnsiMouse(
        terminal,
        () => acceptsMouse(),
        (bytes) => receiveMouse(bytes),
      );
      if (restoreFocus) terminal.focus();
    }
    if (screen.typography !== typography) {
      screen.typography = typography;
      screen.terminal.options.fontFamily = getComputedStyle(
        element.current,
      ).fontFamily;
      screen.terminal.options.fontSize = typography.fontSize;
      screen.terminal.options.lineHeight = typography.lineHeightPercent / 100;
      screen.terminal.element?.style.setProperty(
        "font-feature-settings",
        typography.ligatures ? '"calt" on' : "",
      );
      if (typography.ligatures && screen.ligatureJoiner === undefined) {
        screen.ligatureJoiner =
          screen.terminal.registerCharacterJoiner(joinOperatorRuns);
      } else if (!typography.ligatures && screen.ligatureJoiner !== undefined) {
        screen.terminal.deregisterCharacterJoiner(screen.ligatureJoiner);
        screen.ligatureJoiner = undefined;
      }
      screen.fit.fit();
    }
    screen.terminal.options.theme = palette;
    screen.terminal.options.disableStdin = !enabled;
    screen.terminal.textarea?.setAttribute("aria-label", labels.ansiScreen);
    screen.terminal.textarea?.setAttribute(
      "aria-readonly",
      String(!enabled || pasteBlocksKeys),
    );
    screen.wanted = packets;
    drain(screen);
    reportWindowSize(screen.terminal, screen.terminal);
  }, [
    encoding,
    convertEol,
    enabled,
    labels,
    linkIndex,
    packets,
    palette,
    pasteBlocksKeys,
    scrollback,
    sizeReportEnabled,
    status,
    typography,
  ]);

  return (
    <div
      role="region"
      aria-label={labels.ansiScreen}
      className="workbench-ansi-view"
      style={terminalTypographyStyle(typography)}
    >
      <div className="min-w-0">
        <div className="workbench-ansi-controls">
          <label className="flex items-center gap-2">
            <Switch
              ref={keyboardSwitch}
              checked={enabled}
              disabled={!keyboardScope}
              onCheckedChange={(next) => {
                setFailure(null);
                setArmed(next ? keyboardScope : null);
                if (next) active.current?.terminal.focus();
              }}
            />
            {labels.ansiKeyboard}
          </label>
          {enabled && (
            <label className="flex items-center gap-2">
              <Switch
                checked={mouseEnabled}
                disabled={pasteBlocksKeys}
                onCheckedChange={(next) => {
                  setMouseArmed(next ? keyboardScope : null);
                  if (next) active.current?.terminal.focus();
                }}
              />
              {labels.ansiMouse}
            </label>
          )}
          {enabled && (
            <label
              className="flex items-center gap-2"
              title={labels.ansiSizeReportHint}
            >
              <Switch
                checked={sizeReportEnabled}
                disabled={pasteBlocksKeys}
                onCheckedChange={(next) =>
                  setSizeArmed(next ? keyboardScope : null)
                }
              />
              {labels.ansiSizeReport}
            </label>
          )}
          {enabled && <span>{labels.ansiKeyboardExit}</span>}
          {failure && (
            <span role="status">
              {
                {
                  encoding: labels.unrepresentableEncoding,
                  overflow: labels.ansiKeyboardOverflow,
                  operation: labels.ansiKeyboardError,
                }[failure]
              }
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              status !== "ready" ||
              !history ||
              snapshotStatus?.kind === "saving"
            }
            onClick={() => void exportSnapshot()}
          >
            {labels.ansiExportColors}
          </Button>
          {snapshotStatus?.kind === "error" &&
            snapshotStatus.projection.terminal === history?.terminal && (
              <span role="status">{labels.ansiExportColorsFailed}</span>
            )}
        </div>
        <AnsiHistoryControls
          labels={labels}
          limit={scrollback}
          onLimitChange={onScrollbackChange}
          snapshot={status === "ready" ? history?.snapshot : undefined}
          rawTrimmed={rawTrimmed}
          onJump={jumpToLine}
        />
        <AnsiSearchControls
          terminal={status === "ready" ? history?.terminal : undefined}
          isCurrent={(terminal) => active.current?.terminal === terminal}
          labels={labels}
        />
        {enabled && keyboardScope && (
          <AnsiShellControls
            key={keyboardScope}
            disabled={pasteBlocksKeys || !history}
            labels={labels}
            size={() => active.current?.terminal}
            insert={(command) => {
              const terminal = active.current?.terminal;
              if (
                !terminal ||
                pasteBlocksKeys ||
                !writer.current?.enqueue(new TextEncoder().encode(command))
              )
                return false;
              terminal.focus();
              return true;
            }}
          />
        )}
        {links.length > 0 && (
          <details className="workbench-ansi-links">
            <summary>{labels.ansiLinks}</summary>
            <ul>
              {links.map((href) => (
                <li key={href}>
                  <ExternalLink
                    href={href}
                    onClick={guardLinkActivation}
                    onAuxClick={guardLinkActivation}
                  >
                    {href}
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </details>
        )}
        {paste.preview && paste.payload && (
          <div
            ref={pasteConfirmation}
            role="group"
            aria-label={labels.ansiPaste}
            className="workbench-ansi-controls"
            tabIndex={-1}
          >
            {paste.preview.bracketAvailable && (
              <label className="flex items-center gap-2">
                <Switch
                  checked={paste.preview.bracketed}
                  onCheckedChange={paste.setBracketed}
                />
                {labels.ansiPasteBracketed}
              </label>
            )}
            {"bytes" in paste.payload ? (
              <span role="status">
                {labels.ansiPasteBytes} {paste.payload.bytes.length}
              </span>
            ) : (
              <span role="status">
                {
                  {
                    encoding: labels.unrepresentableEncoding,
                    overflow: labels.ansiPasteTooLarge,
                    bracket: labels.ansiPasteInvalidBracket,
                  }[paste.payload.error]
                }
              </span>
            )}
            <Button
              size="sm"
              disabled={!("bytes" in paste.payload)}
              onClick={() => {
                const terminal = active.current?.terminal;
                if (terminal) {
                  const bracketed = terminal.modes.bracketedPasteMode;
                  void paste.send(bracketed);
                  if (bracketed === paste.preview?.bracketAvailable)
                    terminal.focus();
                }
              }}
            >
              {labels.ansiPaste}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void paste.cancel();
                active.current?.terminal.focus();
              }}
            >
              {labels.cancel}
            </Button>
          </div>
        )}
        {paste.current && (
          <div className="workbench-ansi-controls">
            <span role="status">
              {
                {
                  sending: labels.ansiPasteSending,
                  cancelling: labels.ansiPasteCancelling,
                  sent: labels.ansiPasteSent,
                  cancelled: labels.ansiPasteCancelled,
                  failed: labels.ansiPasteFailed,
                  unconfirmed: labels.ansiPasteUnconfirmed,
                  cancelFailed: labels.ansiPasteCancelFailed,
                }[paste.current.phase]
              }
              {paste.current.accepted !== undefined &&
                ` ${labels.ansiPasteAccepted} ${paste.current.accepted}`}
            </span>
            {paste.busy && (
              <Button
                size="sm"
                variant="outline"
                disabled={paste.current.phase === "cancelling"}
                onClick={() => void paste.cancel()}
              >
                {labels.cancel}
              </Button>
            )}
          </div>
        )}
      </div>
      {status === "ready" ? (
        <div
          ref={element}
          className="workbench-ansi-screen"
          onPasteCapture={(event) => {
            const terminal = active.current?.terminal;
            const input = terminal?.textarea;
            if (!input || event.target !== input) return;
            event.preventDefault();
            event.stopPropagation();
            if (
              enabled &&
              event.nativeEvent.isTrusted &&
              input.ownerDocument.activeElement === input
            )
              paste.prepare(
                event.clipboardData.getData("text/plain"),
                terminal.modes.bracketedPasteMode,
              );
          }}
        />
      ) : (
        <p role="status">
          {status === "error"
            ? labels.encodingLoadFailed
            : labels.encodingLoading}
        </p>
      )}
    </div>
  );
}
