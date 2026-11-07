export const zhRecovery = {
  "recovery.title": "启动故障恢复",
  "recovery.description":
    "在隔离空间中检查启动故障，确认后可安排恢复默认设置。",
  "recovery.isolated": "正在单独的恢复空间中操作",
  "recovery.healthy": "存储正常",
  "recovery.noAction": "当前不需要执行启动恢复。可在设置中调整或重置偏好。",
  "recovery.preserved":
    "原设置仍保留。当前操作只影响单独的恢复空间；请勿手动删除应用数据或相关文件。",
  "recovery.archive": "上次恢复的原件归档：{id}",
  "recovery.diagnostics": "复制问题报告",
  "recovery.copied": "报告已复制，分享前请检查敏感信息。",
  "recovery.schedule": "安排恢复默认设置",
  "recovery.scheduleHint":
    "下次启动时先归档原设置，再替换为默认设置；中断或替换失败会恢复原件。来自更新版本的设置不会被覆盖。",
  "recovery.pending":
    "恢复已排队。当前原件仍保持不变，重新启动后进行验证与安全替换。",
  "recovery.restart": "重新启动并应用恢复",
  "recovery.confirmTitle": "安排恢复默认设置？",
  "recovery.confirmWithSettings":
    "下次启动时先归档原设置，再替换为默认设置。当前原件保持不变；更新版本的设置不会被覆盖。",
  "recovery.confirm": "安排恢复，暂不重启",
} as const;

export type RecoveryMessages = Record<keyof typeof zhRecovery, string>;
