import { useEffect, useState } from "react";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";

/** 仅观察当前输入；提交时仍由 Host 重新授权。 */
export function useToolActionAvailability(
  inputs: readonly HostActionCheckInput[],
  watchActions: HostContextValue["watchActions"],
) {
  const [observation, setObservation] = useState<{
    inputs: readonly HostActionCheckInput[];
    watchActions: HostContextValue["watchActions"];
    values: readonly HostActionAvailability[];
  }>();
  useEffect(() => {
    if (!inputs.length) return;
    let active = true;
    const stop = watchActions(inputs, (values) => {
      if (active) setObservation({ inputs, watchActions, values });
    });
    return () => {
      active = false;
      stop();
    };
  }, [inputs, watchActions]);
  return (input: HostActionCheckInput | undefined) =>
    !!input &&
    observation?.inputs === inputs &&
    observation.watchActions === watchActions &&
    observation.values.some(
      (value) =>
        JSON.stringify(value.input) === JSON.stringify(input) &&
        value.result?.allowed === true &&
        value.error === null,
    );
}
