import type { ActionSpec, Target } from "@serial-workbench/contracts";
import type { AppCommand } from "@/commands/types";
import { useContext, useEffect, useMemo } from "react";
import { CommandsContext } from "@/providers/commands-context";
export type WorkbenchCommandBinding = {
  actionId: string;
  label: string;
  target?: Target;
  available: boolean;
  run: AppCommand["run"];
};
export function buildWorkbenchCommands(
  catalog: readonly ActionSpec[],
  bindings: readonly WorkbenchCommandBinding[],
): AppCommand[] {
  return bindings
    .filter(
      (binding) =>
        binding.available &&
        binding.target &&
        catalog.some(
          (spec) =>
            spec.kind === "action" &&
            spec.actionId === binding.actionId &&
            spec.targetKinds.includes(binding.target!.kind),
        ),
    )
    .map((binding) => ({
      id: `host:${binding.actionId}`,
      labelKey: "workbench.title",
      label: binding.label,
      group: "tools",
      keywords: [binding.actionId],
      run: binding.run,
    }));
}
export function WorkbenchCommands({
  catalog,
  bindings,
}: {
  catalog: readonly ActionSpec[];
  bindings: readonly WorkbenchCommandBinding[];
}) {
  const context = useContext(CommandsContext),
    register = context?.register;
  const commands = useMemo(
    () => buildWorkbenchCommands(catalog, bindings),
    [catalog, bindings],
  );
  useEffect(() => register?.(commands), [commands, register]);
  return null;
}
