import { useEffect, useId, useRef, useState } from "react";
import { validateNodeSourceApproveParams } from "@serial-workbench/contracts";
import type { NodeSourceApproveParams } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { sha256Hex, type Confirmation } from "./node-management";
export function SourceForm({
  revision,
  blocked,
  confirm,
}: {
  revision: string;
  blocked: boolean;
  confirm: (confirmation: Confirmation) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [source, setSource] = useState("");
  const [keyId, setKeyId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function discard() {
    pending.current?.abort();
    setSource("");
    setKeyId("");
    setPublicKey("");
    setError(false);
  }
  useUnsavedWork({
    id,
    label: t("plugins.approveSource"),
    dirty: Boolean(source || keyId || publicKey),
    discard,
  });

  async function review(
    input: Pick<NodeSourceApproveParams, "source" | "keyId"> & { hex: string },
  ) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setError(false);
    if (!/^[0-9a-f]{64}$/i.test(input.hex)) {
      setError(true);
      return;
    }
    const bytes = Uint8Array.from(input.hex.match(/../g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    );
    const publicKeySha256 = await sha256Hex(bytes).catch(() => null);
    if (controller.signal.aborted) return;
    const candidate: unknown = {
      source: input.source,
      keyId: input.keyId,
      publicKey: Array.from(bytes),
      publicKeySha256,
    };
    if (!validateNodeSourceApproveParams(candidate)) {
      setError(true);
      return;
    }
    confirm({
      label: "plugins.approveSource",
      description: "plugins.approveSourceDescription",
      identity: `${candidate.source} / ${candidate.keyId}`,
      intent: {
        kind: "approveSource",
        expectedRevision: revision,
        params: candidate,
      },
    });
  }

  return (
    <form
      className="max-w-xl space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked)
          void review({
            source: source.trim(),
            keyId: keyId.trim(),
            hex: publicKey.trim(),
          });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-source`}>{t("plugins.sourceId")}</Label>
          <Input
            id={`${id}-source`}
            required
            maxLength={128}
            value={source}
            onChange={(event) => {
              pending.current?.abort();
              setSource(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-key`}>{t("plugins.keyId")}</Label>
          <Input
            id={`${id}-key`}
            required
            maxLength={128}
            value={keyId}
            onChange={(event) => {
              pending.current?.abort();
              setKeyId(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-public`}>{t("plugins.publicKey")}</Label>
          <Input
            id={`${id}-public`}
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-public-help`}
            value={publicKey}
            onChange={(event) => {
              pending.current?.abort();
              setPublicKey(event.target.value);
            }}
          />
          <p id={`${id}-public-help`} className="text-xs text-muted-foreground">
            {t("plugins.publicKeyHint")}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("plugins.invalidSource")}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={blocked}>
        {t("plugins.reviewSource")}
      </Button>
    </form>
  );
}
