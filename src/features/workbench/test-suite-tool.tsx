import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Operation, Target } from "@serial-workbench/contracts";
import { ContractValidationError } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { isRecord } from "@/lib/settings-model";
import { isTauri, saveTextExport } from "@/lib/tauri";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { CommandSequenceError } from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import type { Dispatch, SetStateAction } from "react";
import type { CommandSequenceDraft } from "./command-sequence-tool";
import type { TestSuiteSessions } from "./test-suite-sessions";
import {
  readSequenceResult,
  sameSequence,
  type SequenceActionId,
} from "./sequence-workbench-model";
import {
  compileTestSuite,
  runTestSuite,
  suiteCounts,
  suiteHtml,
  suiteJUnit,
  testSuiteMaxBytes,
  type TestSuiteReport,
} from "./test-suite";

type Access = Pick<
  HostContextValue,
  "invoke" | "waitForOperation" | "readFile"
> & {
  port: string;
  target: Target;
  prepareCase: (definition: string, signal: AbortSignal) => Promise<string>;
  cancel: (accepted: Operation, signal: AbortSignal) => Promise<void>;
};
type Series = { key: string; reports: TestSuiteReport[] };
export type TestSuiteWorkspace = TestSuiteSessions & {
  draft: CommandSequenceDraft;
  onDraftChange: Dispatch<SetStateAction<CommandSequenceDraft>>;
  series: readonly Series[];
  onSeriesChange: Dispatch<SetStateAction<readonly Series[]>>;
};
const example = JSON.stringify(
  {
    version: 1,
    name: "Virtual Echo",
    cases: [
      {
        name: "Echo 53",
        sequence: {
          version: 1,
          steps: [{ kind: "send", hex: "53", expect: { hex: "53" } }],
        },
      },
      {
        name: "Echo 54",
        sequence: {
          version: 1,
          steps: [{ kind: "send", hex: "54", expect: { hex: "54" } }],
        },
      },
    ],
  },
  null,
  2,
);

export function TestSuiteTool({
  access,
  actionId,
  beforeReplace,
  draft,
  onDraftChange,
  series,
  onSeriesChange,
  scopeKey,
  sessionKey,
  unresolvedSessions,
  onUnresolvedSessionsChange,
}: TestSuiteWorkspace & {
  access?: Access;
  actionId?: SequenceActionId;
  beforeReplace: () => Promise<boolean>;
  scopeKey: string;
  sessionKey: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const { definition, saved } = draft;
  const [progress, setProgress] = useState<TestSuiteReport>();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const scope = useRef<AbortController | null>(null);
  const controller = useRef<AbortController | null>(null);
  const running = useRef<
    ReturnType<typeof runTestSuite<Operation>> | undefined
  >(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const filePending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => controller.abort();
  }, []);

  const parsed = useMemo(() => {
    if (!definition.trim()) return {};
    try {
      return { suite: compileTestSuite(definition) };
    } catch (error) {
      if (!(error instanceof CommandSequenceError)) throw error;
      return { error };
    }
  }, [definition]);
  const key = parsed.suite
    ? JSON.stringify([scopeKey, parsed.suite])
    : undefined;
  const history = access
    ? (series.find((item) => item.key === key)?.reports ?? [])
    : [];
  const report = busy ? progress : history.at(-1);
  const needsNewSession = unresolvedSessions.has(sessionKey);
  const setDefinition = (value: string) =>
    onDraftChange((previous) => ({ ...previous, definition: value }));

  useUnsavedWork({
    id,
    label: t("testSuite.definition"),
    dirty: definition !== saved || busy,
    retainAfterUnmount: false,
    discard: () => {
      controller.current?.abort();
      setDefinition(saved);
    },
  });

  async function start() {
    const lifetime = scope.current?.signal;
    if (
      !lifetime ||
      !access ||
      !actionId ||
      !parsed.suite ||
      !key ||
      needsNewSession ||
      controller.current ||
      filePending.current
    )
      return;
    const current = new AbortController();
    const signal = AbortSignal.any([current.signal, lifetime]);
    controller.current = current;
    setProgress(undefined);
    setBusy(true);
    setNotice(undefined);
    try {
      const execution = runTestSuite<Operation>(
        parsed.suite,
        {
          prepare: access.prepareCase,
          async invoke(definition, startEventSeq, signal) {
            onUnresolvedSessionsChange(
              (sessions) => new Set([...sessions, sessionKey]),
            );
            const accepted = await access.invoke(
              {
                actionId,
                target: access.target,
                params: { definition, startEventSeq },
                executionMode: "independent",
              },
              signal,
            );
            if (
              accepted.actionId !== actionId ||
              accepted.executionMode !== "independent" ||
              !sameSequence(accepted, access.target)
            )
              throw new ContractValidationError(
                "Test case belongs to another session",
              );
            return accepted;
          },
          async observe(accepted, signal) {
            let terminal: Operation;
            try {
              terminal = await access.waitForOperation(accepted, signal);
            } catch (error) {
              if (
                isRecord(error) &&
                error.operationId === accepted.operationId &&
                error.executionHostId === access.target.hostId
              ) {
                if (error.operationState === "cancelled")
                  return { status: "cancelled" };
                if (error.operationState === "failed")
                  return {
                    status: "failed",
                    reason: nativeErrorCode(error) ?? "operation_failed",
                  };
              }
              throw error;
            }
            const result = await readSequenceResult(
              accepted,
              terminal,
              access.target,
              access.readFile,
              signal,
            );
            if (result.outcome !== "completed")
              return { status: "failed", reason: result.outcome };
            const unresolvedReplies =
              !result.attempts.length ||
              result.attempts.some(
                (entry) =>
                  entry.outcome === "response_timeout" ||
                  entry.outcome === "written",
              );
            signal.throwIfAborted();
            if (!unresolvedReplies)
              onUnresolvedSessionsChange((sessions) => {
                const next = new Set(sessions);
                next.delete(sessionKey);
                return next;
              });
            return { status: "passed", unresolvedReplies };
          },
          cancel: access.cancel,
        },
        signal,
        setProgress,
        (error) => {
          if (controller.current !== current || signal.aborted) return;
          setStopping(false);
          setNotice(nativeErrorText(error, t));
        },
      );
      running.current = execution;
      const result = await execution.finished;
      signal.throwIfAborted();
      onSeriesChange((previous) => {
        const reports =
          previous.find((item) => item.key === key)?.reports ?? [];
        return [
          ...previous.filter((item) => item.key !== key),
          { key, reports: [...reports, result].slice(-8) },
        ].slice(-4);
      });
    } catch (error) {
      if (!signal.aborted) setNotice(nativeErrorText(error, t));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        running.current = undefined;
        if (!lifetime.aborted) {
          setBusy(false);
          setStopping(false);
        }
      }
    }
  }

  function stop() {
    const execution = running.current;
    if (!execution) {
      controller.current?.abort();
      return;
    }
    setStopping(true);
    void execution.stop();
  }

  async function open(file: File) {
    const signal = scope.current?.signal;
    if (!signal || controller.current || filePending.current) return;
    if (!/\.json$/i.test(file.name) || file.size > testSuiteMaxBytes) {
      setNotice(t("commandSequence.fileInvalid"));
      return;
    }
    filePending.current = true;
    setFileBusy(true);
    try {
      const definition = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      signal.throwIfAborted();
      compileTestSuite(definition);
      if ((await beforeReplace()) && !signal.aborted) {
        onDraftChange({ definition, saved: definition });
        setNotice(undefined);
      }
    } catch (error) {
      if (!signal.aborted)
        setNotice(
          error instanceof CommandSequenceError
            ? t("commandSequence.invalid", { path: error.path })
            : t("commandSequence.fileInvalid"),
        );
    } finally {
      filePending.current = false;
      if (!signal.aborted) setFileBusy(false);
    }
  }

  async function save(name: string, content: string) {
    const signal = scope.current?.signal;
    if (!signal || controller.current || filePending.current) return;
    filePending.current = true;
    setFileBusy(true);
    try {
      const saved = await saveTextExport(name, content);
      if (name === "test-suite.json" && saved && isTauri() && !signal.aborted)
        onDraftChange((previous) => ({ ...previous, saved: content }));
    } catch (error) {
      if (!signal.aborted) setNotice(nativeErrorText(error, t));
    } finally {
      filePending.current = false;
      if (!signal.aborted) setFileBusy(false);
    }
  }

  return (
    <section className="grid gap-3">
      {access ? (
        <p>{t("testSuite.destination", { port: access.port })}</p>
      ) : (
        <p>{t("testSuite.unavailable")}</p>
      )}
      <label htmlFor={id}>{t("testSuite.definition")}</label>
      <Textarea
        id={id}
        value={definition}
        onChange={(event) => setDefinition(event.currentTarget.value)}
        maxLength={testSuiteMaxBytes}
        className="min-h-44 font-mono"
        disabled={busy || fileBusy}
        aria-invalid={Boolean(parsed.error)}
        aria-describedby={parsed.error ? id + "-error" : undefined}
      />
      {parsed.error && (
        <p id={id + "-error"} role="alert">
          {t("commandSequence.invalid", { path: parsed.error.path })}
        </p>
      )}
      {notice && <p role="alert">{notice}</p>}
      {!busy && access && needsNewSession && (
        <p role="status">{t("testSuite.needsNewSession")}</p>
      )}
      <input
        hidden
        type="file"
        accept=".json,application/json"
        ref={fileInput}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void open(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || fileBusy}
          onClick={() => fileInput.current?.click()}
        >
          {t("commandSequence.open")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || fileBusy || !parsed.suite}
          onClick={() => void save("test-suite.json", definition)}
        >
          {t(isTauri() ? "commandSequence.save" : "commandSequence.download")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || fileBusy}
          onClick={() => {
            const signal = scope.current?.signal;
            void beforeReplace().then((allowed) => {
              if (
                allowed &&
                signal &&
                !signal.aborted &&
                !controller.current &&
                !filePending.current
              )
                setDefinition(example);
            });
          }}
        >
          {t("commandSequence.example")}
        </Button>
        <Button
          disabled={
            !access ||
            !actionId ||
            !parsed.suite ||
            needsNewSession ||
            busy ||
            fileBusy
          }
          onClick={() => void start()}
        >
          {t("testSuite.run")}
        </Button>
        {busy && (
          <Button variant="outline" disabled={stopping} onClick={stop}>
            {t("testSuite.stop")}
          </Button>
        )}
      </div>
      {busy && (
        <p role="status">
          {t(stopping ? "testSuite.stopping" : "testSuite.running", {
            completed: report?.cases.length ?? 0,
            total: parsed.suite?.cases.length ?? 0,
          })}
        </p>
      )}
      {report && (
        <div className="grid gap-3">
          <table className="w-full text-sm">
            <caption className="text-start">{t("testSuite.results")}</caption>
            <thead>
              <tr>
                <th scope="col" className="text-start">
                  {t("testSuite.case")}
                </th>
                <th scope="col" className="text-start">
                  {t("testSuite.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.cases.map((item) => (
                <tr key={item.name}>
                  <td className="break-all py-1">{item.name}</td>
                  <td className="break-all py-1">
                    {t(`testSuite.status.${item.status}`)}
                    {item.reason && (
                      <>
                        {" "}
                        <code className="text-xs">{item.reason}</code>
                      </>
                    )}
                    {item.operationId && (
                      <code className="block text-xs">{item.operationId}</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={fileBusy}
                onClick={() =>
                  void save("test-suite-report.xml", suiteJUnit(report))
                }
              >
                {t("testSuite.junit")}
              </Button>
              <Button
                variant="outline"
                disabled={fileBusy}
                onClick={() =>
                  void save(
                    "test-suite-report.html",
                    suiteHtml(report, history),
                  )
                }
              >
                {t("testSuite.html")}
              </Button>
            </div>
          )}
        </div>
      )}
      {history.length > 1 && (
        <ol aria-label={t("testSuite.history")} className="grid gap-1 text-sm">
          {history.map((sample, index) => {
            const counts = suiteCounts(sample);
            return (
              <li key={sample.startedAt + index}>
                <time dateTime={sample.startedAt}>{sample.startedAt}</time>{" "}
                {t("testSuite.sample", {
                  passed: counts.passed,
                  total: sample.cases.length,
                })}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
