import { useId, useState, type FormEvent } from "react";
import type { OpenParams } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { rpcJsonObject } from "@/lib/rpc-json";
import { useUnsavedWork } from "@/providers/unsaved-work";
import type { WorkbenchLabels } from "./labels";

export function PluginTransportParameters({
  device,
  labels,
  opening,
  error,
  onSubmit,
}: {
  device: string;
  labels: WorkbenchLabels;
  opening: boolean;
  error?: string;
  onSubmit: (params: NonNullable<OpenParams["transportParams"]>) => void;
}) {
  const id = useId();
  const [text, setText] = useState("{}");
  const [invalid, setInvalid] = useState(false);
  useUnsavedWork({
    id,
    label: labels.pluginTransportParameters,
    dirty: text !== "{}",
    retainAfterUnmount: false,
    discard: () => setText("{}"),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (opening) return;
    let params: NonNullable<OpenParams["transportParams"]>;
    try {
      const value: unknown = JSON.parse(text, (_key, part: unknown) => {
        if (typeof part === "number" && !Number.isSafeInteger(part))
          throw new RangeError("Expected a safe integer");
        return part;
      });
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError("Expected an object");
      params = rpcJsonObject(value);
    } catch {
      setInvalid(true);
      return;
    }
    onSubmit(params);
  }

  const problem = invalid ? labels.pluginTransportInvalid : error;
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <label className="text-sm font-medium wrap-anywhere" htmlFor={id}>
        {device}
      </label>
      <p id={id + "-hint"} className="text-sm text-muted-foreground">
        {labels.pluginTransportHint}
      </p>
      <Textarea
        id={id}
        className="font-mono"
        rows={6}
        spellCheck={false}
        value={text}
        readOnly={opening}
        aria-invalid={invalid || undefined}
        aria-describedby={id + "-hint" + (problem ? " " + id + "-error" : "")}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setInvalid(false);
        }}
      />
      {problem && (
        <p id={id + "-error"} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Button type="submit" disabled={opening} className="self-end">
        {opening ? labels.opening : labels.open}
      </Button>
    </form>
  );
}
