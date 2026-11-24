import { lazy, Suspense, useId, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  SerialConfiguration,
  SessionSnapshot,
} from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import { formatSerialLine } from "./serial-configuration";
import { sessionTemplates } from "./session-templates";
import type { ModbusSlaveAccess } from "./modbus-server-tool";

const AtTool = lazy(() => import("./at-tool"));
const ModbusServerTool = lazy(() => import("./modbus-server-tool"));

export type SessionTemplateConnection = {
  deviceId?: string;
  deviceName?: string;
  eligible: boolean;
  canOpen: boolean;
  opening: boolean;
  open: (configuration: SerialConfiguration) => void;
  close: () => void;
};

export default function SessionTemplateTool({
  connection,
  configuration,
  session,
  error,
  modbusAvailable,
  modbusAccess,
  beforeReplace,
}: {
  connection: SessionTemplateConnection;
  configuration: SerialConfiguration;
  session?: SessionSnapshot;
  error?: string;
  modbusAvailable: boolean;
  modbusAccess?: ModbusSlaveAccess;
  beforeReplace: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const id = useId();
  const [selected, setSelected] =
    useState<keyof typeof sessionTemplates>("stm32");
  const template = sessionTemplates[selected];
  const missing = selected === "modbus" && !modbusAvailable;
  const matches =
    session &&
    session.configuration.baudRate === template.line.baudRate &&
    session.configuration.dataBits === template.line.dataBits &&
    session.configuration.parity === template.line.parity &&
    session.configuration.stopBits === template.line.stopBits &&
    session.configuration.flowControl === template.line.flowControl;

  async function openTemplate() {
    if (connection.canOpen && !missing && (await beforeReplace()))
      connection.open({ ...configuration, ...template.line });
  }

  function openPlugins(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    void beforeReplace().then((allowed) => {
      if (!allowed) return;
      connection.close();
      navigate("/plugins");
    });
  }

  function lineDetails(label: string, line: typeof template.line) {
    return (
      <div
        data-surface="reading"
        className="grid min-w-0 content-start gap-1 rounded-md border p-3"
      >
        <dt className="text-sm font-medium">{label}</dt>
        <dd className="grid gap-1 text-sm wrap-anywhere">
          <code className="font-mono tabular-nums">
            {formatSerialLine(line)}
          </code>
          <span className="text-muted-foreground">
            {t("workbench.tools.flowControl")} ·{" "}
            {t(`workbench.tools.${line.flowControl}`)}
          </span>
        </dd>
      </div>
    );
  }

  return (
    <section className="grid min-w-0 gap-3">
      <div className="grid gap-1.5">
        <label className="text-sm" htmlFor={id}>
          {t("sessionTemplate.label")}
        </label>
        <OptionsSelect
          id={id}
          value={selected}
          options={[
            { value: "stm32", label: t("sessionTemplate.stm32") },
            { value: "at", label: t("sessionTemplate.at") },
            { value: "modbus", label: t("sessionTemplate.modbus") },
          ]}
          disabled={connection.opening}
          onValueChange={(next) =>
            void beforeReplace().then((allowed) => {
              if (allowed) setSelected(next);
            })
          }
        />
      </div>
      <div className="grid gap-1 text-sm wrap-anywhere">
        <p className="font-medium">
          {connection.deviceName ?? t("sessionTemplate.chooseDevice")}
        </p>
        <p className="text-muted-foreground">
          {t(`sessionTemplate.help.${selected}`)}
        </p>
      </div>
      <dl className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-2">
        {lineDetails(t("sessionTemplate.templateLine"), template.line)}
        {session &&
          lineDetails(t("sessionTemplate.currentLine"), session.configuration)}
      </dl>
      {missing && (
        <div className="grid gap-1 text-sm">
          <p role="status">{t("sessionTemplate.modbusMissing")}</p>
          <Link
            className="w-fit underline underline-offset-4"
            to="/plugins"
            onClick={openPlugins}
          >
            {t("sessionTemplate.managePlugins")}
          </Link>
        </div>
      )}
      {!connection.eligible && connection.deviceName && (
        <p role="status">{t("sessionTemplate.ineligible")}</p>
      )}
      {session && (
        <p role="status">
          {t(matches ? "sessionTemplate.opened" : "sessionTemplate.closeFirst")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm wrap-anywhere text-destructive">
          {error}
        </p>
      )}
      <Button
        size="sm"
        className="h-auto min-h-8 w-fit max-w-full whitespace-normal"
        disabled={!connection.canOpen || missing}
        aria-busy={connection.opening || undefined}
        onClick={() => void openTemplate()}
      >
        {t(
          connection.opening
            ? "sessionTemplate.opening"
            : "sessionTemplate.open",
        )}
      </Button>
      {selected === "stm32" && (
        <div className="grid gap-1 border-t pt-3 text-sm">
          <p>{t("sessionTemplate.stm32Sample")}</p>
          <code>Boot OK</code>
        </div>
      )}
      {selected !== "stm32" && (
        <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
          {selected === "at" ? (
            <AtTool initiallyExpanded />
          ) : (
            <ModbusServerTool
              key={JSON.stringify([session?.sessionId, session?.sessionEpoch])}
              initiallyExpanded
              access={matches ? modbusAccess : undefined}
            />
          )}
        </Suspense>
      )}
    </section>
  );
}
