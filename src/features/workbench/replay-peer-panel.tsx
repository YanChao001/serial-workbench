import { useEffect, useId, useMemo, useState } from "react";
import {
  ContractValidationError,
  type ReplayPeerState,
  type Target,
} from "@serial-workbench/contracts";
import {
  formatHex,
  HostRequestError,
  parseHex,
} from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bytesToBase64 } from "@/lib/base64";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import type {
  HostActionAvailability,
  HostContextValue,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useToolAction } from "./transfer-capture-actions";

export type ReplayPeerAccess = Pick<
  HostContextValue,
  "watchActions" | "invoke" | "waitForOperation"
> & {
  read: NonNullable<HostContextValue["readReplayPeer"]>;
};

export function ReplayPeerPanel({
  target,
  recordingName,
  access,
}: {
  target: Target;
  recordingName: string;
  access: ReplayPeerAccess;
}) {
  const { t } = useI18n();
  const title = useId();
  const inputs = useMemo(
    () => [{ actionId: "replay.peer.state", target, params: {} }],
    [target],
  );
  const { watchActions } = access;
  const [observed, setObserved] = useState<{
    inputs: typeof inputs;
    watchActions: typeof watchActions;
    availability: HostActionAvailability | undefined;
  }>();
  useEffect(
    () =>
      watchActions(inputs, ([availability]) =>
        setObserved({ inputs, watchActions, availability }),
      ),
    [inputs, watchActions],
  );

  const availability =
    observed?.inputs === inputs && observed.watchActions === watchActions
      ? observed.availability
      : undefined;
  const allowed = availability?.result?.allowed === true && !availability.error;
  return (
    <section
      className="@container/recorded-peer grid min-h-0 min-w-0 gap-3 overflow-auto py-3"
      aria-labelledby={title}
    >
      <header className="min-w-0">
        <h2 id={title} className="text-base font-medium">
          {t("workbench.replayPeer.title")}
        </h2>
        <p className="wrap-anywhere text-sm text-muted-foreground">
          {recordingName}
        </p>
      </header>
      {allowed ? (
        <PeerExchange access={access} target={target} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {availability?.error || availability?.result
            ? t("workbench.replayPeer.sourceUnavailable")
            : t("workbench.replayPeer.loading")}
        </p>
      )}
    </section>
  );
}

function parseInput(text: string): Uint8Array | undefined {
  try {
    return parseHex(text);
  } catch {
    return undefined;
  }
}

function PeerExchange({
  target,
  access,
}: {
  target: Target;
  access: ReplayPeerAccess;
}) {
  const { t } = useI18n();
  const id = useId();
  const [input, setInput] = useState("");
  const [current, setCurrent] = useState<
    { value: ReplayPeerState } | { error: string }
  >();
  const action = useToolAction((error) => {
    const code = nativeErrorCode(error);
    if (code === "REPLAY_PEER_MISMATCH") {
      const offset =
        error instanceof HostRequestError
          ? error.details.details?.mismatchOffset
          : undefined;
      return typeof offset === "number"
        ? t("workbench.replayPeer.mismatchAt", { position: offset + 1 })
        : t("workbench.replayPeer.mismatch");
    }
    if (code === "REPLAY_PEER_COMPLETE")
      return t("workbench.replayPeer.complete");
    return nativeErrorText(error, t);
  });
  const { read, invoke, waitForOperation } = access;
  useEffect(() => {
    const controller = new AbortController();
    void read(target, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setCurrent({ value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setCurrent({ error: nativeErrorText(error, t) });
      },
    );
    return () => controller.abort();
  }, [read, target, t]);

  const state = current && "value" in current ? current.value : undefined;
  const bytes = useMemo(() => parseInput(input), [input]);
  return (
    <div className="grid min-w-0 items-start gap-4 @min-[36rem]/recorded-peer:grid-cols-2">
      <form
        className="grid min-w-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !state ||
            !bytes?.byteLength ||
            state.progress.atEnd ||
            action.busy
          )
            return;
          void action.run(async (signal) => {
            try {
              const accepted = await invoke(
                {
                  actionId: "replay.peer.submit",
                  target,
                  params: { bytesBase64: bytesToBase64(bytes) },
                  expectedRevision: state.progress.revision,
                  executionMode: "independent",
                },
                signal,
              );
              signal.throwIfAborted();
              const receipt = await waitForOperation(accepted, signal);
              const latest = await read(target, signal);
              signal.throwIfAborted();
              setCurrent({ value: latest });
              if (
                receipt.result?.kind !== "replay_peer_progress" ||
                receipt.result.value.revision !== latest.progress.revision
              )
                throw new ContractValidationError(
                  "Recorded peer revision changed after submission",
                );
              setInput("");
            } catch (error: unknown) {
              signal.throwIfAborted();
              const code = nativeErrorCode(error);
              if (code === "PERMISSION_DENIED" || code === "REFERENCE_CHANGED")
                setCurrent({
                  error: t("workbench.replayPeer.sourceUnavailable"),
                });
              else if (code === "REVISION_CONFLICT") {
                const value = await read(target, signal);
                signal.throwIfAborted();
                setCurrent({ value });
              }
              throw error;
            }
          });
        }}
      >
        <label htmlFor={id + "-input"} className="text-sm font-medium">
          {t("workbench.replayPeer.hexInput")}
        </label>
        <Textarea
          id={id + "-input"}
          value={input}
          className="min-h-24 font-mono text-sm"
          spellCheck={false}
          aria-invalid={bytes === undefined}
          disabled={action.busy}
          onChange={(event) => setInput(event.target.value)}
        />
        {bytes === undefined && (
          <p className="text-sm text-destructive">
            {t("workbench.replayPeer.invalidHex")}
          </p>
        )}
        <Button
          type="submit"
          size="sm"
          className="justify-self-start"
          disabled={
            !state || state.progress.atEnd || !bytes?.byteLength || action.busy
          }
        >
          {t("workbench.replayPeer.submit")}
        </Button>
        {action.error && (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        )}
        {current && "error" in current && (
          <p role="alert" className="text-sm text-destructive">
            {current.error}
          </p>
        )}
        {!current && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("workbench.replayPeer.loading")}
          </p>
        )}
        {state && (
          <p role="status" className="text-sm text-muted-foreground">
            {state.progress.atEnd
              ? t("workbench.replayPeer.complete")
              : t("workbench.replayPeer.progress", {
                  turns: state.progress.completedTurns,
                  bytes: state.progress.remainingRequestBytes,
                })}
          </p>
        )}
      </form>
      <section
        className="grid min-w-0 gap-2 rounded-md border p-3"
        aria-labelledby={id + "-responses"}
      >
        <h3 id={id + "-responses"} className="text-sm font-medium">
          {t("workbench.replayPeer.responses")}
        </h3>
        {state &&
          (state.responses.length ? (
            <ul className="grid max-h-48 gap-2 overflow-y-auto">
              {state.responses.map((response) => (
                <li key={response.recordOrdinal} className="grid min-w-0 gap-1">
                  <span className="text-sm text-muted-foreground">
                    {t("workbench.replayPeer.record", {
                      ordinal: response.recordOrdinal,
                    })}
                  </span>
                  <code className="wrap-anywhere font-mono text-sm">
                    {formatHex(
                      Uint8Array.from(atob(response.bytesBase64), (character) =>
                        character.charCodeAt(0),
                      ),
                    )}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("workbench.replayPeer.noResponse")}
            </p>
          ))}
      </section>
    </div>
  );
}
