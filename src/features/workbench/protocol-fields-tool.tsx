import { lazy, Suspense } from "react";
import { useI18n } from "@/providers/i18n";
import type { FramingFrame } from "./framing-model";
import type { FramingInspection } from "./framing-anomalies-model";
import type { ModbusTransactionAccess } from "./modbus-transaction";
import type { ModbusSlaveAccess } from "./modbus-server-tool";
import type { ProtocolDefinitionFileAccess } from "./protocol-definition-file";

const ProtocolFieldPreview = lazy(() => import("./protocol-field-preview"));
const CrcRecognitionTool = lazy(() => import("./crc-recognition-tool"));
const ModbusFrameTool = lazy(() => import("./modbus-frame-tool"));
const ModbusServerTool = lazy(() => import("./modbus-server-tool"));
const ModbusTimelineTool = lazy(() => import("./modbus-timeline-tool"));
const ModbusRegisterTool = lazy(() => import("./modbus-register-tool"));
const NmeaTool = lazy(() => import("./nmea-tool"));
const AtTool = lazy(() => import("./at-tool"));

export function ProtocolFieldsTool({
  frames,
  inspection,
  fileAccess,
  modbusTimeline,
  modbusSlave,
}: {
  frames: readonly FramingFrame[];
  inspection?: FramingInspection;
  fileAccess?: ProtocolDefinitionFileAccess;
  modbusTimeline?: ModbusTransactionAccess;
  modbusSlave?: ModbusSlaveAccess;
}) {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
      <ProtocolFieldPreview
        frames={frames}
        fileAccess={fileAccess}
        inspection={inspection}
      />
      <CrcRecognitionTool />
      <ModbusFrameTool />
      {modbusTimeline ? <ModbusTimelineTool access={modbusTimeline} /> : null}
      {modbusTimeline ? <ModbusRegisterTool access={modbusTimeline} /> : null}
      <ModbusServerTool access={modbusSlave} />
      <NmeaTool />
      <AtTool />
    </Suspense>
  );
}
