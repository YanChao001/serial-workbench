import type { UserLogModule } from "@/lib/user-log";

/** 保留故障来源与稳定错误码，界面文案按当前语言生成。 */
export type WorkbenchFailure = {
  module: UserLogModule;
  code?: string;
  message: string;
  occurrence: number;
  eventKey?: string;
  context?: string;
  deviceId?: string;
};
