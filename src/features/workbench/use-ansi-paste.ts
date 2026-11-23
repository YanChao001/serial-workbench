import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  TX_MAX_BYTES,
  type Operation,
  type TextEncoding,
} from "@serial-workbench/contracts";
import { encodeAnsiPaste, type AnsiPasteTarget } from "./ansi-paste";

type PasteDraft = {
  scope: string;
  text: string;
  bracketAvailable: boolean;
  bracketed: boolean;
};

type PasteNotice = {
  scope: string;
  phase:
    | "sending"
    | "cancelling"
    | "sent"
    | "cancelled"
    | "failed"
    | "unconfirmed"
    | "cancelFailed";
  accepted?: string;
};

type PasteRun = {
  admission: Promise<Operation>;
  controller: AbortController;
  cancel: AnsiPasteTarget["cancel"];
  cancelling: boolean;
  settled: boolean;
};

export function useAnsiPaste(
  scope: string | null,
  target: AnsiPasteTarget | undefined,
  encoding: TextEncoding,
) {
  const [draft, setDraft] = useState<PasteDraft | null>(null);
  const [notice, setNotice] = useState<PasteNotice | null>(null);
  const active = useRef<PasteRun | null>(null);

  if (draft && draft.scope !== scope) setDraft(null);
  if (notice && notice.scope !== scope) setNotice(null);
  const preview = draft?.scope === scope ? draft : null;
  const current = notice?.scope === scope ? notice : null;
  const payload = useMemo(
    () =>
      preview
        ? encodeAnsiPaste(preview.text, encoding, preview.bracketed)
        : null,
    [preview, encoding],
  );
  const busy =
    current?.phase === "sending" ||
    current?.phase === "cancelling" ||
    current?.phase === "cancelFailed";

  useLayoutEffect(
    () => () => {
      active.current?.controller.abort();
      active.current = null;
    },
    [scope],
  );

  function prepare(text: string, bracketAvailable: boolean) {
    if (!scope || !target || !text || active.current) return;
    setNotice(null);
    setDraft({
      scope,
      text: text.slice(0, TX_MAX_BYTES * 2 + 1),
      bracketAvailable,
      bracketed: bracketAvailable,
    });
  }

  async function send(bracketAvailable: boolean) {
    if (!scope || !target || !preview || !payload || active.current) return;
    if (preview.bracketAvailable !== bracketAvailable) {
      setDraft({ ...preview, bracketAvailable, bracketed: bracketAvailable });
      return;
    }
    if (!("bytes" in payload)) return;
    const bytes = payload.bytes;
    const controller = new AbortController();
    const run: PasteRun = {
      admission: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return target.start(bytes);
      }),
      controller,
      cancel: target.cancel,
      cancelling: false,
      settled: false,
    };
    active.current = run;
    setDraft(null);
    setNotice({ scope, phase: "sending" });
    try {
      const accepted = await run.admission;
      const settled = await target.wait(accepted, controller.signal);
      run.settled = true;
      if (active.current !== run) return;
      const count =
        settled.result?.kind === "file_transfer"
          ? settled.result.value.accepted
          : undefined;
      const phase =
        settled.state === "succeeded" && count === String(bytes.length)
          ? "sent"
          : settled.state === "cancelled"
            ? "cancelled"
            : "failed";
      setNotice({ scope, phase, accepted: count });
    } catch {
      if (active.current === run) setNotice({ scope, phase: "unconfirmed" });
    } finally {
      if (active.current === run) active.current = null;
    }
  }

  async function cancel() {
    setDraft(null);
    const run = active.current;
    if (!scope || !run || run.cancelling) return;
    run.cancelling = true;
    setNotice({ scope, phase: "cancelling" });
    try {
      // A user cancel can arrive before the Host returns the admitted operation ID.
      const operation = await run.admission;
      if (!run.settled) await run.cancel(operation);
    } catch {
      if (active.current === run) {
        run.cancelling = false;
        setNotice({ scope, phase: "cancelFailed" });
      }
    }
  }

  return {
    preview,
    payload,
    current,
    busy,
    prepare,
    send,
    cancel,
    setBracketed(bracketed: boolean) {
      if (preview) setDraft({ ...preview, bracketed });
    },
  };
}
