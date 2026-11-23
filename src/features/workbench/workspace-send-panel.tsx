import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { SendPanel, type SendPanelProps } from "./send-panel";
import type { DraftStore } from "./draft-store";
import type { TextSendPreview } from "@/lib/text-encoding";

/** 文字只订阅当前草稿，权限预览在输入停顿后才编码；保存和发送始终使用同步正文。 */
export function WorkspaceSendPanel({
  drafts,
  draftKey,
  onPreviewChange,
  ...props
}: Omit<SendPanelProps, "draft" | "onDraftChange" | "onPreviewChange"> & {
  drafts: DraftStore;
  draftKey: string;
  onPreviewChange?: (bytes: Uint8Array | null) => void;
}) {
  const snapshot = useCallback(() => drafts.get(draftKey), [drafts, draftKey]);
  const draft = useSyncExternalStore(drafts.subscribe, snapshot, snapshot);
  const onDraftChange = useCallback(
    (value: string) => drafts.change(draftKey, value),
    [drafts, draftKey],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const preview = useCallback(
    (prepared: TextSendPreview | null) => {
      clearTimeout(timer.current);
      // 新正文立即使旧参数的可执行性过期，真实发送仍由 Host 按当前字节验权。
      onPreviewChange?.(null);
      if (onPreviewChange && prepared?.byteLength)
        timer.current = setTimeout(
          () => onPreviewChange(prepared.readBytes()),
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
      checksumDraftKey={draftKey}
      onDraftChange={onDraftChange}
      onPreviewChange={preview}
    />
  );
}
