import { useId, useState } from "react";
import vectors from "../../../resources/examples/workbench/vectors.json";
import peerSource from "../../../resources/examples/workbench/swb-example-peer.mjs?raw";
import sketchSource from "../../../resources/examples/workbench/SwbExample.ino?raw";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/code-block";
import { nativeErrorText } from "@/lib/native-error";
import {
  isTauri,
  saveSampleProjectArtifact,
  saveTextExport,
  type SampleProjectArtifact,
} from "@/lib/tauri";
import { useI18n } from "@/providers/i18n";

const artifacts = {
  peer: { name: "swb-example-peer.mjs", source: peerSource },
  arduinoSketch: { name: "SwbExample.ino", source: sketchSource },
} satisfies Record<SampleProjectArtifact, { name: string; source: string }>;

export function SampleProject({ project }: { project: keyof typeof vectors }) {
  const { t } = useI18n();
  const headingId = useId();
  const example = vectors[project];
  const format = example.format === "hex" ? "HEX" : t("sessionProject.crlf");
  const [saving, setSaving] = useState(false);
  const [saveOutcome, setSaveOutcome] = useState<"saved" | "downloading">();
  const [error, setError] = useState<string>();

  async function save(artifact: SampleProjectArtifact) {
    if (saving) return;
    setSaving(true);
    setSaveOutcome(undefined);
    setError(undefined);
    try {
      const { name, source } = artifacts[artifact];
      if (isTauri()) {
        const result = await saveSampleProjectArtifact(artifact);
        if (result !== null) setSaveOutcome("saved");
      } else {
        await saveTextExport(name, source);
        setSaveOutcome("downloading");
      }
    } catch (reason) {
      setError(nativeErrorText(reason, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="grid min-w-0 gap-3 border-t pt-3 text-sm"
    >
      <h3 id={headingId} className="font-medium">
        {t("sessionProject.title")}
      </h3>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2">
        {(["request", "response"] as const).map((field) => (
          <div
            key={field}
            data-surface="reading"
            className="grid min-w-0 content-start gap-1 rounded-md border p-3"
          >
            <dt className="font-medium">{t(`sessionProject.${field}`)}</dt>
            <dd className="grid min-w-0 gap-1">
              <span className="text-muted-foreground">{format}</span>
              <CodeBlock
                code={example[field]}
                language="text"
                className="min-w-0 whitespace-pre-wrap wrap-anywhere p-1"
              />
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-1">
        <p>{t("sessionProject.simulator")}</p>
        <CodeBlock
          code={`node swb-example-peer.mjs ${project}`}
          language="text"
          className="min-w-0 whitespace-pre-wrap wrap-anywhere p-1"
        />
        <p className="text-muted-foreground">{t("sessionProject.runtime")}</p>
        <p className="text-muted-foreground">
          {t(`sessionProject.device.${project}`)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => void save("peer")}
        >
          {t("sessionProject.savePeer")}
        </Button>
        {project === "arduino" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void save("arduinoSketch")}
          >
            {t("sessionProject.saveArduino")}
          </Button>
        )}
      </div>
      {saveOutcome && <p role="status">{t(`sessionProject.${saveOutcome}`)}</p>}
      {error && (
        <p role="alert" className="text-destructive wrap-anywhere">
          {error}
        </p>
      )}
    </section>
  );
}
