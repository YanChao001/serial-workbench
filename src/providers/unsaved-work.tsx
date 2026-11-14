import {
  UnsavedWorkContext as Context,
  UnsavedWorkScopeContext as ScopeContext,
  type UnsavedWork,
} from "./unsaved-work-context";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import { nativeErrorText } from "@/lib/native-error";
import {
  isTauri,
  onLifecycleRequest,
  onLifecycleFinished,
  onLifecycleExecuting,
  respondLifecycle,
  setWindowWorkState,
  type LifecycleRequest,
} from "@/lib/tauri";

export type { UnsavedWork } from "./unsaved-work-context";

export function UnsavedWorkScope({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const registry = useContext(Context);
  useEffect(() => () => registry?.releaseScope(scope), [registry, scope]);
  return (
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  );
}

export function useRequestLeave() {
  const registry = useContext(Context);
  return useCallback(
    (scope: string, signal?: AbortSignal) =>
      registry?.requestLeave(scope, signal) ??
      Promise.resolve(!signal?.aborted),
    [registry],
  );
}

type RegisteredWork = { work: UnsavedWork; scope?: string };
type LeaveRequest =
  | { kind: "native"; value: LifecycleRequest }
  | { kind: "scope"; scope: string; settle: (allowed: boolean) => void };

function belongsTo(entry: RegisteredWork, request: LeaveRequest) {
  return (
    entry.work.dirty &&
    (request.kind === "native" || entry.scope === request.scope)
  );
}

/** 脏工作在离页后仍保留最后一个保存动作，保存成功或明确放弃后移除。 */
export function useUnsavedWork(work: UnsavedWork) {
  const registry = useContext(Context);
  const scope = useContext(ScopeContext);
  useEffect(() => {
    registry?.register(work, scope);
  });
  useEffect(() => () => registry?.unregister(work.id), [registry, work.id]);
}

export function UnsavedWorkProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const items = useRef(new Map<string, RegisteredWork>());
  const operation = useRef<AbortController | null>(null);
  const requestId = useRef<number | null>(null);
  const completedThrough = useRef(0);
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<LeaveRequest | null>(null);
  const [request, setRequest] = useState<LeaveRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [listening, setListening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const errorText = error === null ? null : nativeErrorText(error, t);
  const errorToastId = useId();
  const notifiedError = useRef<string | null>(null);
  const register = useCallback((work: UnsavedWork, scope?: string) => {
    const previous = items.current.get(work.id)?.work;
    items.current.set(work.id, { work, scope });
    if (
      (!previous && work.dirty) ||
      previous?.dirty !== work.dirty ||
      (work.dirty &&
        (previous?.label !== work.label ||
          Boolean(previous?.save) !== Boolean(work.save)))
    )
      setRevision((v) => v + 1);
  }, []);
  const unregister = useCallback((id: string) => {
    if (!items.current.get(id)?.work.dirty) items.current.delete(id);
  }, []);
  const finishScoped = useCallback((target: LeaveRequest, allowed: boolean) => {
    if (target.kind !== "scope" || activeRequest.current !== target) return;
    activeRequest.current = null;
    if (!allowed) operation.current?.abort();
    setRequest(null);
    setError(null);
    target.settle(allowed);
  }, []);
  const requestLeave = useCallback(
    (scope: string, signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted || activeRequest.current || operation.current)
        return Promise.resolve(false);
      if (
        ![...items.current.values()].some(
          (entry) => entry.scope === scope && entry.work.dirty,
        )
      )
        return Promise.resolve(true);
      return new Promise((resolve) => {
        const target: LeaveRequest = {
          kind: "scope",
          scope,
          settle: (allowed) => {
            signal?.removeEventListener("abort", abort);
            resolve(allowed);
          },
        };
        const abort = () => finishScoped(target, false);
        signal?.addEventListener("abort", abort, { once: true });
        activeRequest.current = target;
        setError(null);
        setWaiting(false);
        setExecuting(false);
        setRequest(target);
      });
    },
    [finishScoped],
  );
  const releaseScope = useCallback(
    (scope: string) => {
      const target = activeRequest.current;
      if (target?.kind === "scope" && target.scope === scope)
        finishScoped(target, false);
    },
    [finishScoped],
  );
  const registry = useMemo(
    () => ({ register, unregister, requestLeave, releaseScope }),
    [register, unregister, requestLeave, releaseScope],
  );
  useEffect(() => {
    let stopped = false;
    if (isTauri() && listening)
      void setWindowWorkState(
        [...items.current.values()]
          .filter((v) => v.work.dirty)
          .map((v) => v.work.label),
      ).catch((reason: unknown) => {
        if (!stopped) setError(reason);
      });
    return () => {
      stopped = true;
    };
  }, [revision, listening]);
  useEffect(() => {
    let stopped = false;
    const stops: (() => void)[] = [];
    const attach = (promise: Promise<() => void>) =>
      promise.then((stop) => {
        if (stopped) stop();
        else stops.push(stop);
      });
    const requests = attach(
      onLifecycleRequest((value) => {
        if (
          stopped ||
          value.id <= completedThrough.current ||
          (requestId.current !== null && value.id <= requestId.current)
        )
          return;
        operation.current?.abort();
        const current = activeRequest.current;
        if (current?.kind === "scope") finishScoped(current, false);
        requestId.current = value.id;
        const target: LeaveRequest = { kind: "native", value };
        activeRequest.current = target;
        setBusy(operation.current !== null);
        setExecuting(false);
        setError(null);
        setWaiting(false);
        setRequest(target);
      }),
    );
    const finished = attach(
      onLifecycleFinished((id) => {
        if (stopped) return;
        completedThrough.current = Math.max(completedThrough.current, id);
        if (requestId.current === id) {
          operation.current?.abort();
          activeRequest.current = null;
          requestId.current = null;
          setBusy(operation.current !== null);
          setRequest(null);
          setWaiting(false);
          setExecuting(false);
        }
      }),
    );
    const execution = attach(
      onLifecycleExecuting((id) => {
        if (!stopped && requestId.current === id) setExecuting(true);
      }),
    );
    void Promise.all([requests, finished, execution])
      .then(() => {
        if (!stopped) {
          setListening(true);
        }
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(reason);
      });
    const warn = (event: BeforeUnloadEvent) => {
      if ([...items.current.values()].some((v) => v.work.dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      stopped = true;
      operation.current?.abort();
      const target = activeRequest.current;
      if (target?.kind === "scope") finishScoped(target, false);
      stops.forEach((stop) => stop());
      window.removeEventListener("beforeunload", warn);
    };
  }, [attempt, finishScoped]);
  const answer = useCallback(
    async (choice: "save" | "discard" | "cancel") => {
      if (
        !request ||
        activeRequest.current !== request ||
        executing ||
        ((operation.current || waiting) && choice !== "cancel")
      )
        return;
      if (choice === "cancel") {
        operation.current?.abort();
        if (request.kind === "scope") {
          finishScoped(request, false);
          return;
        }
        const id = request.value.id;
        try {
          await respondLifecycle(id, false);
          if (activeRequest.current === request) {
            activeRequest.current = null;
            requestId.current = null;
            setRequest(null);
            setWaiting(false);
            setBusy(operation.current !== null);
          }
        } catch (reason) {
          if (requestId.current === id) setError(reason);
        }
        return;
      }
      if (
        choice === "save" &&
        [...items.current.values()].some(
          (entry) => belongsTo(entry, request) && !entry.work.save,
        )
      )
        return;
      const controller = new AbortController();
      operation.current = controller;
      setBusy(true);
      setError(null);
      try {
        for (const entry of [...items.current.values()].filter((v) =>
          belongsTo(v, request),
        )) {
          const { work } = entry;
          // A callback may register a newer edit while an earlier save is pending.
          if (items.current.get(work.id)?.work !== work) continue;
          if (choice === "save") await work.save?.(controller.signal);
          else await work.discard(controller.signal);
          controller.signal.throwIfAborted();
          if (items.current.get(work.id)?.work === work)
            items.current.delete(work.id);
        }
        setRevision((v) => v + 1);
        controller.signal.throwIfAborted();
        if (
          activeRequest.current !== request ||
          [...items.current.values()].some((v) => belongsTo(v, request))
        )
          return;
        if (request.kind === "scope") finishScoped(request, true);
        else {
          await respondLifecycle(request.value.id, true);
          if (activeRequest.current === request) setWaiting(true);
        }
      } catch (reason) {
        if (!controller.signal.aborted && activeRequest.current === request)
          setError(reason);
      } finally {
        if (operation.current === controller) {
          operation.current = null;
          setBusy(false);
        }
      }
    },
    [request, waiting, executing, finishScoped],
  );
  useEffect(() => {
    if (
      request &&
      !busy &&
      !waiting &&
      error === null &&
      ![...items.current.values()].some((entry) => belongsTo(entry, request))
    )
      void answer("save");
  }, [request, revision, busy, waiting, error, answer]);
  useEffect(() => {
    if (!errorText || request) {
      notifiedError.current = null;
      toast.dismiss(errorToastId);
      return;
    }
    if (notifiedError.current === errorText) return;
    notifiedError.current = errorText;
    toast.error(errorText, {
      id: errorToastId,
      duration: Infinity,
      action: {
        label: t("common.retry"),
        onClick: () => {
          setError(null);
          setListening(false);
          setAttempt((value) => value + 1);
        },
      },
    });
  }, [errorText, request, errorToastId, t]);
  useEffect(
    () => () => {
      toast.dismiss(errorToastId);
    },
    [errorToastId],
  );
  const presented = useRef<
    | {
        request: LeaveRequest;
        labels: string[];
        canSave: boolean;
        count: number;
      }
    | undefined
  >(undefined);
  if (
    request &&
    (presented.current?.request !== request ||
      (!busy && !waiting && !executing))
  ) {
    const work = [...items.current.values()]
      .filter((entry) => belongsTo(entry, request))
      .map((entry) => entry.work);
    if (work.length || presented.current?.request !== request)
      presented.current = {
        request,
        labels: work.map((work) => work.label),
        canSave: work.every((work) => Boolean(work.save)),
        count: request.kind === "native" ? request.value.windows.length : 1,
      };
  }
  return (
    <Context.Provider value={registry}>
      {children}
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) void answer("cancel");
        }}
      >
        <DialogContent
          className="min-w-0 sm:max-w-xl"
          data-lifecycle-request={
            request?.kind === "native" ? request.value.id : undefined
          }
          data-lifecycle-phase={
            executing
              ? "executing"
              : waiting
                ? "waiting"
                : busy
                  ? "saving"
                  : "prompt"
          }
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t("lifecycle.title")}</DialogTitle>
            <DialogDescription>
              {t("lifecycle.description", {
                count: presented.current?.count ?? 1,
              })}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-inside list-disc text-sm">
            {presented.current?.labels.map((label, index) => (
              <li key={`${index}:${label}`}>{label}</li>
            ))}
          </ul>
          <div
            className="h-16 overflow-y-auto text-sm"
            tabIndex={errorText ? 0 : undefined}
            data-lifecycle-status
          >
            {errorText ? (
              <p role="alert" className="text-destructive">
                {errorText}
              </p>
            ) : busy || waiting || executing ? (
              <p role="status">
                {t(
                  executing
                    ? "lifecycle.executing"
                    : waiting
                      ? "lifecycle.waiting"
                      : "lifecycle.saving",
                )}
              </p>
            ) : null}
          </div>
          <DialogFooter className="sm:flex-wrap [&>button]:whitespace-normal">
            <Button
              variant="outline"
              disabled={executing}
              onClick={() => void answer("cancel")}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || waiting}
              onClick={() => void answer("discard")}
            >
              {t("lifecycle.discard")}
            </Button>
            {presented.current?.canSave && (
              <Button
                disabled={busy || waiting}
                onClick={() => void answer("save")}
              >
                {busy ? t("lifecycle.saving") : t("lifecycle.save")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
