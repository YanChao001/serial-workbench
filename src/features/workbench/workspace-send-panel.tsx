import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  CommandDraft,
  TerminalMode,
  TextEncoding,
} from "@serial-workbench/contracts";
import type { TextSendPreview } from "@/lib/text-encoding";
import { SendPanel, type SendPanelProps } from "./send-panel";
import type { DraftStore } from "./draft-store";
import {
  CommandLibraryButton,
  type CommandLibrarySource,
} from "./command-library";

export type SendPermissionPreview = {
  prepared: TextSendPreview;
  bytes: Uint8Array;
};

/** 文字只订阅当前草稿，权限预览在输入停顿后才编码。保存和发送始终使用同步正文。 */
export function WorkspaceSendPanel({
  drafts,
  draftKey,
  onPreviewChange,
  commandLibrary,
  draftActions,
  draftReadOnly,
  onSendModeChange,
  onEncodingChange,
  ...props
}: Omit<
  SendPanelProps,
  | "draft"
  | "onDraftChange"
  | "onPreviewChange"
  | "command"
  | "onClearCommandEnding"
  | "onClearDraft"
> & {
  drafts: DraftStore;
  draftKey: string;
  commandLibrary?: CommandLibrarySource;
  onPreviewChange?: (preview: SendPermissionPreview | null) => void;
}) {
  const snapshot = useCallback(() => drafts.get(draftKey), [drafts, draftKey]);
  const draft = useSyncExternalStore(drafts.subscribe, snapshot, snapshot);
  const commandSnapshot = useCallback(
    () => drafts.getCommand(draftKey),
    [drafts, draftKey],
  );
  const command = useSyncExternalStore(
    drafts.subscribe,
    commandSnapshot,
    commandSnapshot,
  );
  const onDraftChange = useCallback(
    (value: string) => drafts.change(draftKey, value),
    [drafts, draftKey],
  );
  const applyCommand = useCallback(
    (value: CommandDraft) => drafts.useCommand(draftKey, value),
    [drafts, draftKey],
  );
  const clearDraft = useCallback(
    () => drafts.clear(draftKey),
    [drafts, draftKey],
  );
  const clearCommandEnding = useCallback(
    () => drafts.editCommandOptions(draftKey, { lineEnding: undefined }),
    [drafts, draftKey],
  );
  const changeMode = useCallback(
    (mode: TerminalMode) => {
      drafts.editCommandOptions(draftKey, { mode });
      onSendModeChange?.(mode);
    },
    [drafts, draftKey, onSendModeChange],
  );
  const changeEncoding = useCallback(
    (encoding: TextEncoding) => {
      drafts.editCommandOptions(draftKey, { encoding });
      onEncodingChange?.(encoding);
    },
    [drafts, draftKey, onEncodingChange],
  );
  const actions = useMemo(
    () => (
      <>
        {commandLibrary && (
          <CommandLibraryButton
            key={commandLibrary.scope}
            {...commandLibrary}
            onUse={draftReadOnly ? undefined : applyCommand}
          />
        )}
        {draftActions}
      </>
    ),
    [applyCommand, commandLibrary, draftActions, draftReadOnly],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const preview = useCallback(
    (prepared: TextSendPreview | null) => {
      clearTimeout(timer.current);
      // 新正文立即使旧参数的可执行性过期，真实发送仍由 Host 按当前字节验权。
      onPreviewChange?.(null);
      if (onPreviewChange && prepared?.byteLength)
        timer.current = setTimeout(
          () => onPreviewChange({ prepared, bytes: prepared.readBytes() }),
          150,
        );
    },
    [onPreviewChange],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <SendPanel
      {...props}
      draft={draft}
      draftReadOnly={draftReadOnly}
      command={command}
      onClearCommandEnding={clearCommandEnding}
      onClearDraft={clearDraft}
      mode={command?.mode ?? props.mode}
      onSendModeChange={changeMode}
      encoding={command?.encoding ?? props.encoding}
      onEncodingChange={changeEncoding}
      draftActions={actions}
      draftOwnerKey={draftKey}
      onDraftChange={onDraftChange}
      onPreviewChange={preview}
    />
  );
}
