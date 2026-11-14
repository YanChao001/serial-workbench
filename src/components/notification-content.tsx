import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

const NotificationFrameContext =
  createContext<RefObject<HTMLDivElement | null> | null>(null);

export function NotificationContent({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  return (
    <NotificationFrameContext value={frame}>
      <div
        ref={frame}
        className="app-notification"
        data-surface="popover"
        onBlur={(event) => {
          // 详情通过 Portal 呈现，焦点仍属于通知，避免 Sonner 抢回原页面。
          if (
            event.relatedTarget instanceof Element &&
            event.relatedTarget.closest(".app-notification-details")
          )
            event.stopPropagation();
        }}
      >
        {children}
      </div>
    </NotificationFrameContext>
  );
}

/** 详情脱离通知布局，展开不会改变通知及其堆叠的位置。 */
export function NotificationDetails({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  const frame = useContext(NotificationFrameContext);
  return (
    <Popover>
      {/* 直接引用真实容器，保留布局观察能力；不伪造原点矩形作为后备。 */}
      {frame && <PopoverAnchor virtualRef={frame} />}
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="app-notification-details"
        align="end"
        side="top"
        collisionPadding={8}
        aria-label={label}
      >
        <PopoverTitle>{label}</PopoverTitle>
        <pre
          role="region"
          aria-label={label}
          tabIndex={0}
          className="app-notification-details-text"
        >
          <code>{children}</code>
        </pre>
      </PopoverContent>
    </Popover>
  );
}
