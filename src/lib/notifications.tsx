import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import { NotificationContent } from "@/components/notification-content";

/** 自定义通知统一附加正文容器，寿命与标识继续由 Sonner 管理。 */
export function notifyCustom(
  render: (id: string | number) => ReactNode,
  options?: ExternalToast,
) {
  return toast.custom(
    (id) => <NotificationContent>{render(id)}</NotificationContent>,
    options,
  );
}
