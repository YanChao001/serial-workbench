import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLatestTranslator } from "@/hooks/use-latest-translator";
import type { ShortcutBinding } from "@/lib/generated/bindings";
import { nativeErrorText } from "@/lib/native-error";
import { configureGlobalSend, isTauri, setGlobalSendTarget } from "@/lib/tauri";

type SendTarget = (signal: AbortSignal) => void;

export function useGlobalSendShortcut(suspended: boolean) {
  const t = useLatestTranslator();
  const [binding, setBinding] = useState<ShortcutBinding>();
  const state = useRef<{
    registration?: string;
    revision: number;
    suspended: boolean;
    target?: () => void;
  }>({ revision: 0, suspended });
  const publishTarget = useCallback(() => {
    const current = state.current;
    const { registration, target, suspended } = current;
    const revision = ++current.revision;
    if (registration) {
      void setGlobalSendTarget(
        registration,
        revision,
        !!target && !suspended,
      ).catch((error: unknown) => {
        if (
          current.registration === registration &&
          current.revision === revision
        )
          toast.error(nativeErrorText(error, t));
      });
    }
  }, [t]);

  useLayoutEffect(() => {
    state.current.suspended = suspended;
    publishTarget();
  }, [publishTarget, suspended]);

  const registerTarget = useCallback(
    (send: SendTarget) => {
      const controller = new AbortController();
      const target = () => send(controller.signal);
      state.current.target = target;
      publishTarget();
      return () => {
        controller.abort();
        if (state.current.target === target) {
          state.current.target = undefined;
          publishTarget();
        }
      };
    },
    [publishTarget],
  );

  const changeBinding = useCallback(
    async (next: ShortcutBinding | undefined) => {
      const registration = crypto.randomUUID();
      await configureGlobalSend(next, registration, (revision) => {
        const current = state.current;
        if (
          !current.suspended &&
          current.registration === registration &&
          current.revision === revision
        )
          current.target?.();
      });
      state.current.registration = next ? registration : undefined;
      setBinding(next);
      publishTarget();
    },
    [publishTarget],
  );

  return useMemo(
    () => (isTauri() ? { binding, changeBinding, registerTarget } : undefined),
    [binding, changeBinding, registerTarget],
  );
}
