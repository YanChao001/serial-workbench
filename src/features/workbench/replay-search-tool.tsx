import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import type {
  ReplaySearchCommand,
  ReplaySearchHit,
  ReplaySearchPage,
  ReplaySearchParams,
  ReplaySearchResult,
  TextEncoding,
} from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Translate } from "@/i18n/translate";
import { bytesToBase64 } from "@/lib/base64";
import { nativeErrorCode } from "@/lib/native-error";
import { replaySourceUnavailable } from "./replay-source-unavailable";
import { encodeText, prepareTextEncoding } from "@/lib/text-encoding";
import type { HostContextValue } from "@/providers/host-context";
import { TextEncodingSelect } from "./text-encoding-select";
import { WorkbenchDialog } from "./workbench-dialog";
import { WorkbenchIconButton } from "./workbench-icon-button";

export type ReplaySearcher = (
  params: ReplaySearchParams,
) => Promise<ReplaySearchResult>;
export type ReplaySearchOptions = {
  run: ReplaySearcher;
  t: Translate;
  hostId: string;
  watchActions: HostContextValue["watchActions"];
};

type Attempt = {
  id: string;
  request: (command: ReplaySearchCommand) => Promise<ReplaySearchResult>;
  cancelled: boolean;
  next: string;
  work?: Promise<void>;
  stopping?: Promise<void>;
};
type Phase =
  | "idle"
  | "preparing"
  | "scanning"
  | "ready"
  | "complete"
  | "stopping"
  | "stopped"
  | "error";
type Failure =
  | "workbench.replaySearchInvalid"
  | "workbench.replaySearchLength"
  | "workbench.replaySearchFailed"
  | "workbench.replaySearchStopFailed"
  | "workbench.replaySearchUnavailable"
  | "workbench.replaySearchJumpFailed";
type View = {
  phase: Phase;
  progress?: ReplaySearchPage;
  page?: ReplaySearchPage;
  failure?: Failure;
  query?: string;
};
const initial: View = { phase: "idle" };

/** Cancel now and reconcile a start that the Host may accept after the first stop. */
function release(attempt: Attempt) {
  attempt.cancelled = true;
  if (attempt.stopping) return attempt.stopping;
  const work = attempt.work;
  const stop = { kind: "stop", searchId: attempt.id } as const;
  const stopping = (async () => {
    const result = await attempt.request(stop);
    if (result.kind !== "stopped")
      throw new Error("Replay stop result changed");
    await work;
    if (!result.stopped && work) {
      const retry = await attempt.request(stop);
      if (retry.kind !== "stopped")
        throw new Error("Replay stop result changed");
    }
  })();
  attempt.stopping = stopping;
  void stopping.catch(() => {
    attempt.stopping = undefined;
  });
  return stopping;
}

export function ReplaySearchTool({
  search: { run, t },
  target,
  recording,
  initialEncoding,
  closeLabel,
  jumpDisabled,
  fallbackFocus,
  onSourceUnavailable,
  onJump,
}: {
  search: ReplaySearchOptions;
  target: Pick<ReplaySearchParams, "sessionId" | "sessionEpoch">;
  recording: string;
  initialEncoding: TextEncoding;
  closeLabel: string;
  jumpDisabled: boolean;
  fallbackFocus?: React.RefObject<HTMLElement | null>;
  onSourceUnavailable?: () => void;
  onJump: (hit: ReplaySearchHit, signal: AbortSignal) => Promise<boolean>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [openOwner, setOpenOwner] = useState<{
    run: ReplaySearcher;
    id: string;
    epoch: string;
  }>();
  const [view, setView] = useState<View>(initial);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"text" | "hex">("text");
  const [direction, setDirection] = useState<"both" | "rx" | "tx">("both");
  const [encoding, setEncoding] = useState(initialEncoding);
  const [jumping, setJumping] = useState(false);
  const active = useRef<Attempt | undefined>(undefined);
  const revision = useRef(0);
  const launching = useRef(false);
  const jump = useRef<AbortController | undefined>(undefined);
  const contentId = useId();
  const open =
    openOwner?.run === run &&
    openOwner.id === target.sessionId &&
    openOwner.epoch === target.sessionEpoch;
  const title = t("workbench.replaySearch");
  const query = JSON.stringify([
    text,
    mode,
    direction,
    mode === "text" ? encoding : null,
  ]);
  const showingMatches = view.query === query;
  const page = showingMatches ? view.page : undefined;
  const progress = showingMatches ? view.progress : undefined;
  const locked =
    view.phase === "preparing" ||
    view.phase === "scanning" ||
    view.phase === "stopping" ||
    jumping;

  useEffect(
    () => () => {
      revision.current++;
      jump.current?.abort();
      const current = active.current;
      active.current = undefined;
      if (current) void release(current).catch(() => {});
    },
    [run, target.sessionId, target.sessionEpoch],
  );

  function close() {
    revision.current++;
    jump.current?.abort();
    setOpenOwner(undefined);
    const current = active.current;
    if (current) void retire(current).catch(() => {});
  }
  async function retire(attempt: Attempt) {
    await release(attempt);
    if (active.current === attempt) active.current = undefined;
  }
  function showError(failure: Failure, discard = false) {
    setView((before) => ({
      ...(discard ? initial : before),
      failure,
      phase: "error",
    }));
  }
  function showRequestError(error: unknown, fallback: Failure) {
    const code = nativeErrorCode(error);
    const unavailable = replaySourceUnavailable(code);
    // NOT_FOUND can mean that the search cursor expired. Archive reads still work.
    if (unavailable && code !== "NOT_FOUND") onSourceUnavailable?.();
    showError(
      unavailable ? "workbench.replaySearchUnavailable" : fallback,
      unavailable,
    );
  }
  function scan(attempt: Attempt, first: ReplaySearchCommand) {
    const work = (async () => {
      let command = first;
      let scanned = -1n;
      try {
        while (!attempt.cancelled) {
          const reply = await attempt.request(command);
          if (attempt.cancelled || active.current !== attempt) return;
          if (reply.kind !== "page")
            throw new Error("Replay search result changed");
          const page = reply.result;
          const count = BigInt(page.scannedRecords);
          if (!page.hits.length && !page.complete && count <= scanned)
            throw new Error("Replay search did not advance");
          scanned = count;
          attempt.next = (BigInt(reply.page) + 1n).toString();
          setView((before) => ({
            ...before,
            progress: page,
            page: page.hits.length ? page : before.page,
            phase: page.complete
              ? "complete"
              : page.hits.length
                ? "ready"
                : "scanning",
          }));
          if (page.complete || page.hits.length) return;
          command = { kind: "next", searchId: attempt.id, page: attempt.next };
        }
      } catch (error) {
        if (!attempt.cancelled && active.current === attempt)
          showRequestError(error, "workbench.replaySearchFailed");
      }
    })();
    attempt.work = work;
    void work.finally(() => {
      if (attempt.work === work) attempt.work = undefined;
    });
  }
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (launching.current || locked) return;
    launching.current = true;
    const started = revision.current;
    setView({ phase: "preparing" });
    let failure: Failure = "workbench.replaySearchInvalid";
    try {
      if (mode === "text") await prepareTextEncoding(encoding);
      const bytes =
        mode === "hex" ? parseHex(text) : encodeText(text, encoding);
      if (started !== revision.current) return;
      if (bytes.length < 1 || bytes.length > 256) {
        showError("workbench.replaySearchLength");
        return;
      }
      failure = "workbench.replaySearchStopFailed";
      if (active.current) await retire(active.current);
      if (started !== revision.current) return;
      const attempt: Attempt = {
        id: crypto.randomUUID(),
        cancelled: false,
        next: "1",
        request: (command) => run({ ...target, command }),
      };
      active.current = attempt;
      setView({ phase: "scanning", query });
      scan(attempt, {
        kind: "start",
        searchId: attempt.id,
        bytesBase64: bytesToBase64(bytes),
        ...(direction === "both" ? {} : { direction }),
      });
    } catch (error) {
      if (started === revision.current) showRequestError(error, failure);
    } finally {
      launching.current = false;
    }
  }
  function next() {
    const attempt = active.current;
    if (
      !attempt ||
      attempt.cancelled ||
      attempt.work ||
      view.phase !== "ready" ||
      !showingMatches
    )
      return;
    setView((before) => ({ ...before, phase: "scanning" }));
    scan(attempt, { kind: "next", searchId: attempt.id, page: attempt.next });
  }
  async function stop() {
    const attempt = active.current;
    if (!attempt || view.phase === "stopping") return;
    const started = revision.current;
    setView((before) => ({ ...before, phase: "stopping", failure: undefined }));
    try {
      await retire(attempt);
      if (started === revision.current)
        setView((before) => ({ ...before, phase: "stopped" }));
    } catch (error) {
      if (started === revision.current)
        showRequestError(error, "workbench.replaySearchStopFailed");
    }
  }
  async function locate(hit: ReplaySearchHit) {
    if (jump.current || jumpDisabled) return;
    const controller = new AbortController();
    jump.current = controller;
    setJumping(true);
    try {
      if (await onJump(hit, controller.signal)) {
        if (!controller.signal.aborted) close();
      } else if (!controller.signal.aborted) {
        setView((before) => ({
          ...before,
          failure: "workbench.replaySearchJumpFailed",
        }));
      }
    } finally {
      if (jump.current === controller) {
        jump.current = undefined;
        setJumping(false);
      }
    }
  }
  const status =
    view.phase === "stopping"
      ? t("workbench.replaySearchStopping")
      : view.phase === "stopped"
        ? t("workbench.replaySearchStopped")
        : (view.phase === "preparing" || view.phase === "scanning") &&
            !view.progress
          ? t("workbench.replaySearching")
          : view.phase === "complete" && showingMatches && !page
            ? t("workbench.replaySearchEmpty")
            : "";
  return (
    <>
      <WorkbenchIconButton
        ref={trigger}
        label={title}
        onClick={() => {
          revision.current++;
          setView(initial);
          setOpenOwner({
            run,
            id: target.sessionId,
            epoch: target.sessionEpoch,
          });
        }}
      >
        <Search aria-hidden="true" />
      </WorkbenchIconButton>
      <WorkbenchDialog
        open={open}
        title={title}
        closeLabel={closeLabel}
        scopeKey={target.sessionId + ":" + target.sessionEpoch}
        returnFocus={{
          get current() {
            return trigger.current?.isConnected
              ? trigger.current
              : (fallbackFocus?.current ?? null);
          },
        }}
        onRequestClose={close}
      >
        <form
          onSubmit={(event) => void start(event)}
          className="workbench-tool-form workbench-replay-search"
        >
          <p className="workbench-replay-search-name">{recording}</p>
          <div
            className="workbench-replay-search-fields"
            data-search-format={mode}
          >
            <div className="workbench-replay-search-input">
              <Label htmlFor={contentId}>
                {t("workbench.replaySearchContent")}
              </Label>
              <Input
                id={contentId}
                value={text}
                disabled={locked}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <Select
              value={mode}
              disabled={locked}
              onValueChange={(value) => {
                if (value === "text" || value === "hex") setMode(value);
              }}
            >
              <SelectTrigger aria-label={t("workbench.replaySearchMode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">
                  {t("workbench.replaySearchText")}
                </SelectItem>
                <SelectItem value="hex">HEX</SelectItem>
              </SelectContent>
            </Select>
            {mode === "text" && (
              <TextEncodingSelect
                value={encoding}
                disabled={locked}
                label={t("workbench.replaySearchEncoding")}
                onChange={(value) => {
                  if (value) setEncoding(value);
                }}
              />
            )}
            <Select
              value={direction}
              disabled={locked}
              onValueChange={(value) => {
                if (value === "both" || value === "rx" || value === "tx")
                  setDirection(value);
              }}
            >
              <SelectTrigger aria-label={t("workbench.replaySearchDirection")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">
                  {t("workbench.replaySearchBoth")}
                </SelectItem>
                <SelectItem value="rx">RX</SelectItem>
                <SelectItem value="tx">
                  {t("workbench.replaySearchTx")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="workbench-replay-search-actions">
            <Button type="submit" size="sm" disabled={locked || !text.length}>
              {t("workbench.replaySearchStart")}
            </Button>
            {view.phase === "ready" && showingMatches && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={jumping}
                onClick={next}
              >
                {t("workbench.replaySearchNext")}
              </Button>
            )}
            {active.current && view.phase !== "complete" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={view.phase === "stopping"}
                onClick={() => void stop()}
              >
                {t("workbench.replaySearchStop")}
              </Button>
            )}
          </div>
          {(status || progress) && (
            <p role="status">
              {status}{" "}
              {progress &&
                t("workbench.replaySearchProgress", {
                  scanned: progress.scannedRecords,
                  total: progress.totalRecords,
                })}
            </p>
          )}
          {view.failure && (
            <p className="workbench-error" role="alert">
              {t(view.failure)}
            </p>
          )}
          {!!page?.hits.length && (
            <ol
              className="workbench-replay-search-results"
              tabIndex={0}
              aria-label={t("workbench.replaySearchResults")}
            >
              {page.hits.map((hit) => (
                <li
                  key={[
                    hit.firstRecord,
                    hit.lastRecord,
                    hit.direction,
                    hit.byteStart,
                  ].join(":")}
                >
                  <div>
                    <span>
                      {hit.direction === "rx"
                        ? "RX"
                        : t("workbench.replaySearchTx")}
                    </span>
                    <span>
                      {t("workbench.replaySearchRecord", {
                        record:
                          hit.firstRecord === hit.lastRecord
                            ? hit.firstRecord
                            : hit.firstRecord + "–" + hit.lastRecord,
                        start: hit.byteStart,
                        end: hit.byteEnd,
                      })}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={jumpDisabled || jumping}
                    onClick={() => void locate(hit)}
                  >
                    {t("workbench.replaySearchJump")}
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </form>
      </WorkbenchDialog>
    </>
  );
}
