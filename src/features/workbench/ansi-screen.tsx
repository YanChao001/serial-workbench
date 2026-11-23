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
import { createTextDecoder } from "@/lib/text-encoding";
import { CommandsContext } from "@/providers/commands-context";
import type { WorkbenchLabels } from "./labels";
import { ansiReceiveTail, type AnsiReceive } from "./ansi-receive";
import {
  createAnsiKeyboardWriter,
  encodeAnsiKey,
  type AnsiKeyboardTarget,
} from "./ansi-keyboard";
import { ansiLinkUrl, createAnsiLinkIndex } from "./ansi-links";
import { bindAnsiMouse, selectsAnsiText } from "./ansi-mouse";
import { decodeBytes } from "./stream-model";
import { terminalTypographyStyle } from "./stream-presentation";
import { useAnsiPaste } from "./use-ansi-paste";

const PALETTES = {
  light: { foreground: "#172034", background: "#ffffff" },
  dark: { foreground: "#e5ebf4", background: "#171e2c" },
} satisfies Record<string, ITheme>;
const WRITE_BATCH_BYTES = 64 * 1024;

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
  typography?: TerminalTypography;
  disposeMouse?: () => void;
};

function project(
  element: HTMLDivElement,
  encoding: TextEncoding,
  convertEol: boolean,
  palette: ITheme,
): Projection {
  const terminal = new Terminal({
    disableStdin: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    screenReaderMode: true,
    convertEol,
    scrollback: 3_000,
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
  };
}

function dispose(projection: Projection | null) {
  if (!projection) return;
  projection.disposed = true;
  projection.observer.disconnect();
  projection.disposeMouse?.();
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
  labels,
}: {
  items: readonly StreamItem[];
  encoding: TextEncoding;
  convertEol: boolean;
  sendEncoding: TextEncoding;
  keyboard?: AnsiKeyboardTarget;
  typography?: TerminalTypography;
  labels: WorkbenchLabels;
}) {
  const element = useRef<HTMLDivElement>(null);
  const keyboardSwitch = useRef<HTMLButtonElement>(null);
  const pasteConfirmation = useRef<HTMLDivElement>(null);
  const active = useRef<Projection | null>(null);
  const status = useTextEncoding(encoding);
  const sendStatus = useTextEncoding(sendEncoding);
  const commands = useContext(CommandsContext);
  const openExternal = useOpenExternal();
  const [linkIndex] = useState(createAnsiLinkIndex);
  const links = useSyncExternalStore(linkIndex.subscribe, linkIndex.snapshot);
  const writer = useRef<ReturnType<typeof createAnsiKeyboardWriter> | null>(
    null,
  );
  const [armed, setArmed] = useState<string | null>(null);
  const [mouseArmed, setMouseArmed] = useState<string | null>(null);
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
  const paste = useAnsiPaste(
    enabled && keyboard?.paste ? keyboardScope : null,
    keyboard?.paste,
    sendEncoding,
  );
  const hasPastePreview = !!paste.preview;
  const pasteBlocksKeys = hasPastePreview || paste.busy;
  const { resolvedTheme } = useTheme();
  const palette = resolvedTheme === "dark" ? PALETTES.dark : PALETTES.light;
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
      !screen.wanted.every((packet, index) => packet === packets[index])
    ) {
      const previousInput = screen?.terminal.textarea;
      const restoreFocus =
        enabled &&
        !!previousInput &&
        previousInput.ownerDocument.activeElement === previousInput;
      dispose(screen);
      linkIndex.clear();
      screen = project(element.current, encoding, convertEol, palette);
      active.current = screen;
      const terminal = screen.terminal;
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
  }, [
    encoding,
    convertEol,
    enabled,
    labels,
    linkIndex,
    packets,
    palette,
    pasteBlocksKeys,
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
        </div>
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
