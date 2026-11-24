import { lazy, Suspense } from "react";
import { useI18n } from "@/providers/i18n";
import type { FramingFrame } from "./framing-model";
import type { ModbusTimelineAccess } from "./modbus-timeline-tool";
import type { ProtocolDefinitionFileAccess } from "./protocol-definition-file";

const ProtocolFieldPreview = lazy(() => import("./protocol-field-preview"));
const CrcRecognitionTool = lazy(() => import("./crc-recognition-tool"));
const ModbusFrameTool = lazy(() => import("./modbus-frame-tool"));
const ModbusServerTool = lazy(() => import("./modbus-server-tool"));
const ModbusTimelineTool = lazy(() => import("./modbus-timeline-tool"));
const NmeaTool = lazy(() => import("./nmea-tool"));
const AtTool = lazy(() => import("./at-tool"));

export function ProtocolFieldsTool({
  frames,
  fileAccess,
  modbusTimeline,
}: {
  frames: readonly FramingFrame[];
  fileAccess?: ProtocolDefinitionFileAccess;
  modbusTimeline?: ModbusTimelineAccess;
}) {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
      <ProtocolFieldPreview frames={frames} fileAccess={fileAccess} />
      <CrcRecognitionTool />
      <ModbusFrameTool />
      {modbusTimeline ? <ModbusTimelineTool access={modbusTimeline} /> : null}
      <ModbusServerTool />
      <NmeaTool />
      <AtTool />
    </Suspense>
  );
}
