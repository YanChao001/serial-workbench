import { readFileSync, writeFileSync } from "node:fs";

function code(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}
function revision(value) {
  return typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
    ? value
    : undefined;
}
function choice(value, values) {
  return values.includes(value) ? value : undefined;
}
function percentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}
function settingsValues(value) {
  const background = value?.background;
  return {
    language: choice(value?.language, ["en", "zh"]),
    theme: choice(value?.theme, ["system", "light", "dark"]),
    backgroundKind: choice(background?.kind, ["none", "preset", "media"]),
    // 此场景仅核对内置皮肤；不记录用户媒体引用、名称或路径。
    backgroundPreset:
      background?.kind === "preset" && background.value === "sakura"
        ? "sakura"
        : undefined,
    backgroundIntensity: percentage(value?.backgroundIntensity),
  };
}

/** 由 WebDriver 在真实页面执行；只汇总状态，不返回可能包含用户数据的提示正文。 */
export function settingsSaveUiObservation() {
  const root = globalThis.document.documentElement;
  const messages = [
    ...globalThis.document.querySelectorAll(
      '[role="status"], [role="alert"], [data-sonner-toast]',
    ),
  ].map((element) => element.textContent ?? "");
  return {
    language: root.lang,
    theme: root.classList.contains("dark") ? "dark" : "light",
    backgroundIntensity: Number(root.dataset.backgroundIntensity),
    persistence: {
      error: messages.some((text) =>
        /Settings not saved|设置未保存/.test(text),
      ),
      saving: messages.some((text) => /Saving…|保存中…/.test(text)),
      loading: messages.some((text) =>
        /Syncing settings…|同步设置…/.test(text),
      ),
    },
  };
}

/** 保留原等待门槛；失败后仅落盘已观察值，绝不追加 Host 查询或附着。 */
export async function waitForSettingsCommit({
  readSettings,
  readUi,
  waitUntil,
  matches,
  outputPath,
  candidatePath,
}) {
  let candidate;
  try {
    candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  } catch {
    // 诊断缺少收据时仍执行原断言；不以补充观测替代真实测试失败。
  }
  const digest = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
      ? value
      : undefined;
  const evidence = {
    formatVersion: 1,
    scope: "native fresh settings commit wait",
    candidate: {
      observed: candidate !== undefined,
      source: digest(candidate?.source),
      executableSha256: digest(candidate?.sha256),
      target:
        typeof candidate?.target === "string" &&
        /^[a-z0-9][a-z0-9_-]{0,95}$/.test(candidate.target)
          ? candidate.target
          : undefined,
    },
    polls: 0,
    seenPersistence: { error: false, saving: false, loading: false },
    nativeConnection: {
      // readSettings 的显式附着可能建立新代次，不能证明 GUI Provider 的旧连接健康。
      provesGuiConnectionHealth: false,
    },
  };
  const observedConnection = (value) => {
    const phase = choice(value?.phase, [
      "attachment_observed",
      "attachment_failed",
      "query_replied",
      "query_failed",
    ]);
    if (!phase) return;
    evidence.nativeConnection = {
      ...evidence.nativeConnection,
      ...(revision(value.generation) !== undefined
        ? { generation: revision(value.generation) }
        : {}),
      phase,
      errorCode: code(value.errorCode),
    };
  };
  let completed = false;
  try {
    await waitUntil(async () => {
      evidence.polls++;
      try {
        const ui = await readUi();
        evidence.gui = {
          language: choice(ui?.language, ["en", "zh", "zh-CN"]),
          theme: choice(ui?.theme, ["light", "dark"]),
          backgroundIntensity: percentage(ui?.backgroundIntensity),
          persistence: Object.fromEntries(
            ["error", "saving", "loading"].map((key) => [
              key,
              ui?.persistence?.[key] === true,
            ]),
          ),
        };
        // 浮层到期不抹去等待期间确实出现过的故障或保存状态。
        for (const key of ["error", "saving", "loading"])
          evidence.seenPersistence[key] ||= evidence.gui.persistence[key];
        delete evidence.guiObservationError;
      } catch (error) {
        evidence.guiObservationError = code(error?.code) ?? "NOT_OBSERVED";
      }
      try {
        const result = await readSettings(observedConnection);
        evidence.stored = {
          ...settingsValues(result?.settings),
          revision: revision(result?.revision),
          clientRevision: revision(result?.client?.revision),
        };
        delete evidence.readErrorCode;
        return matches(result);
      } catch (error) {
        evidence.readErrorCode = code(error?.code) ?? "UNKNOWN";
        throw error;
      }
    });
    completed = true;
  } finally {
    if (!completed) {
      try {
        writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
      } catch {
        // 保留原断言失败，不用诊断文件写入错误掩盖它，也不输出用户目录。
        console.warn("Unable to write settings commit failure evidence.");
      }
    }
  }
}
