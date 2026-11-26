import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLatestTranslator } from "@/hooks/use-latest-translator";
import type { ShortcutBinding } from "@/lib/generated/bindings";
import { nativeErrorText } from "@/lib/native-error";
import { configureGlobalSend, isTauri, setGlobalSendTarget } from "@/lib/tauri";

type SendTarget = (signal: AbortSignal) => void;

export function useGlobalSendShortcut(suspended: boolean) {
  const t = useLatestTranslator();
  const [binding, setBinding] = useState<{
    requested: ShortcutBinding;
    systemTrigger?: string;
  }>();
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
      let liveTrigger: string | null | undefined;
      function publishBinding(trigger: string | null | undefined) {
        const active = next && trigger !== null;
        state.current.registration = active ? registration : undefined;
        setBinding(
          active ? { requested: next, systemTrigger: trigger } : undefined,
        );
      }
      const systemTrigger = await configureGlobalSend(
        next,
        registration,
        t("commands.globalSend"),
        (event) => {
          const current = state.current;
          if (event.kind === "binding") {
            liveTrigger = event.trigger;
            if (current.registration === registration)
              publishBinding(liveTrigger);
          } else if (
            !current.suspended &&
            current.registration === registration &&
            current.revision === event.revision
          ) {
            current.target?.();
          }
        },
      );
      // 系统撤回可能比命令回执更早到达，保留信道中的最新状态。
      publishBinding(
        liveTrigger === undefined ? (systemTrigger ?? undefined) : liveTrigger,
      );
      publishTarget();
    },
    [publishTarget, t],
  );

  return useMemo(
    () =>
      isTauri()
        ? {
            binding: binding?.requested,
            systemTrigger: binding?.systemTrigger,
            changeBinding,
            registerTarget,
          }
        : undefined,
    [binding, changeBinding, registerTarget],
  );
}
