import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { notifyCustom } from "@/lib/notifications";
import { recordUserLog, type UserLogInput } from "@/lib/user-log";
export {
  operationFailureKey,
  operationFailureEventKey,
} from "@/lib/operation-failure";

// 窗口级真实事件账本：独立于工具的挂载周期，不保留操作输入或原始错误。
const EVENT_LIMIT = 512;
const events = new Map<string, boolean>();
function emitEvent(
  eventKey: string,
  children: ReactNode,
  log?: UserLogInput,
  inline = false,
) {
  const shown = events.get(eventKey);
  if (shown !== undefined) {
    if (inline && shown) {
      events.set(eventKey, false);
      toast.dismiss(eventKey);
    }
    return;
  }
  events.set(eventKey, !inline);
  if (events.size > EVENT_LIMIT) events.delete(events.keys().next().value!);
  if (log) recordUserLog(log, eventKey);
  if (inline) return;
  // 真实事件的五秒寿命不随工具关闭、路由切换或 StrictMode 的清理重置。
  notifyCustom(() => children, {
    id: eventKey,
    duration: 5000,
    closeButton: true,
  });
}

export function notifyWorkbenchFailure(eventKey: string, log: UserLogInput) {
  emitEvent(
    eventKey,
    <span role="alert">
      {log.context ? `${log.context}: ` : ""}
      {log.message}
    </span>,
    log,
  );
}

/** 持续告警的通知寿命与逐条事件日志分离，不因后续事件刷新五秒计时。 */
export function notifyWorkbenchMessage(eventKey: string, message: string) {
  emitEvent(eventKey, <span>{message}</span>);
}

function noticeContent() {
  let value: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: ReactNode) {
      if (value === next) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function NoticeContent({
  content,
}: {
  content: ReturnType<typeof noticeContent>;
}) {
  const value = useSyncExternalStore(
    content.subscribe,
    content.getSnapshot,
    () => null,
  );
  return <>{value}</>;
}

/** 通知使用应用现有右下角浮层，连接和动作状态不参与工作台尺寸计算。 */
export function WorkbenchNotice({
  children,
  noticeKey,
  log,
  eventKey,
  duration = 5000,
  dismissible = true,
  inline = false,
}: {
  children: ReactNode;
  noticeKey: string;
  log?: UserLogInput;
  /** 真实操作身份；同一事件跨工具重开和多个展示入口只通知、入账一次。 */
  eventKey?: string;
  /** 持续状态可延长至完成；独立事件仍沿用五秒寿命。 */
  duration?: number;
  dismissible?: boolean;
  /** 已在操作所在的工具窗展示，仍沿用通知的事件及日志去重。 */
  inline?: boolean;
}) {
  const id = useId();
  const active = useRef<{
    id: string;
    content: ReturnType<typeof noticeContent>;
    shown: string;
    duration: number;
    presented: boolean;
  } | null>(null);
  const identity = useRef(0);
  const episode = useRef(0);
  useEffect(() => {
    if (eventKey) {
      if (children) emitEvent(eventKey, children, log, inline);
      return;
    }
    if (!children) {
      if (active.current) {
        episode.current++;
        active.current.content.update(null);
        if (active.current.presented) toast.dismiss(active.current.id);
        active.current = null;
      }
      return;
    }
    const previous = active.current;
    // 相同状态只更新正文；用户关闭或自动结束后，不因普通重渲染再次弹出。
    if (previous?.shown === noticeKey && previous.duration === duration) {
      if (previous.presented) {
        previous.content.update(inline ? null : children);
        if (inline) {
          previous.presented = false;
          toast.dismiss(previous.id);
        }
      }
      return;
    }
    if (previous) {
      previous.content.update(null);
      if (previous.presented) toast.dismiss(previous.id);
    }
    // 状态或寿命变化属于新一轮；旧退出动画和到期回调不能删除或缩短新通知。
    const entry = {
      id: `${id}:${identity.current++}`,
      content: noticeContent(),
      shown: noticeKey,
      duration,
      presented: !inline,
    };
    active.current = entry;
    entry.content.update(children);
    if (log) recordUserLog(log, `${id}:${noticeKey}:${episode.current}`);
    if (inline) return;
    const owned = entry;
    notifyCustom(() => <NoticeContent content={owned.content} />, {
      id: owned.id,
      duration,
      closeButton: dismissible,
      dismissible,
    });
  }, [children, id, log, noticeKey, eventKey, duration, dismissible, inline]);
  useEffect(
    () => () => {
      if (active.current) {
        active.current.content.update(null);
        if (active.current.presented) toast.dismiss(active.current.id);
        active.current = null;
      }
    },
    [id],
  );
  return null;
}
