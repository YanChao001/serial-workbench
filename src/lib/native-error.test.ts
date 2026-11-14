// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { errorMessage, nativeErrorText } from "./native-error";

describe("native error presentation", () => {
  it.each([zhCN, en])(
    "explains local service authentication failure without displaying raw details",
    (messages) => {
      expect(
        nativeErrorText(
          {
            code: "UNAUTHENTICATED",
            message: "EXPLICIT_FIXTURE_SECRET C:/private/user",
          },
          createTranslator(messages),
        ),
      ).toBe(messages["nativeError.unauthenticated"]);
    },
  );
  it("explains quarantined serial cleanup without guessing a permission or platform problem", () => {
    expect(
      nativeErrorText(
        {
          code: "CONTROL_UNKNOWN",
          message: "Native serial resources remain isolated",
        },
        createTranslator(zhCN),
      ),
    ).toBe("串口操作结果未确认，请重新连接后重试。");
  });
  it("explains a busy serial device without exposing backend wording", () => {
    expect(
      nativeErrorText(
        { code: "DEVICE_BUSY", message: "Native serial operation failed" },
        createTranslator(zhCN),
      ),
    ).toBe("设备正在使用或上次操作尚未结束，请稍后重试。");
  });
  it("uses stable codes and keeps useful Error and string messages", () => {
    const t = createTranslator(en);
    expect(
      nativeErrorText({ code: "CONFLICT", message: "internal detail" }, t),
    ).toBe(en["errors.CONFLICT"]);
    expect(nativeErrorText(new Error("offline"), t)).toBe(
      "Operation failed: offline",
    );
    expect(nativeErrorText("offline", t)).toBe("Operation failed: offline");
  });
  it("presents unknown objects without string coercion or exposing their contents", () => {
    const unknown = {
      secret: "private",
      toString() {
        throw new Error("unsafe coercion");
      },
    };
    expect(errorMessage(unknown)).toBe("Unknown error");
    expect(nativeErrorText(unknown, createTranslator(zhCN))).toBe(
      zhCN["errors.INTERNAL"],
    );
    expect(nativeErrorText(null, createTranslator(en))).toBe(
      en["errors.INTERNAL"],
    );
  });
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "未知错误码 %s 不会读取对象原型成员或使翻译崩溃",
    (code) => {
      const t = createTranslator(en);
      expect(nativeErrorText({ code, message: "offline" }, t)).toBe(
        "Operation failed: offline",
      );
      expect(nativeErrorText({ code }, t)).toBe(en["errors.INTERNAL"]);
    },
  );
  it.each([
    ["NATIVE_BUSY", "nativeError.busy"],
    ["DEVICE_BUSY", "nativeError.deviceBusy"],
    ["HOST_BUSY", "nativeError.hostBusy"],
    ["DEV_RUNTIME_MISMATCH", "nativeError.devRuntimeMismatch"],
    ["WRITE_TIMEOUT", "nativeError.writeTimeout"],
    ["READER_OVERFLOW", "nativeError.readerOverflow"],
    ["CONFIGURATION_CONFLICT", "nativeError.configurationConflict"],
    ["UNSUPPORTED_CAPABILITY", "errors.UNSUPPORTED"],
    ["ACCESS_DENIED", "nativeError.accessDenied"],
    ["PERMISSION_DENIED", "nativeError.permissionDenied"],
  ] as const)("presents %s with its stable localized message", (code, key) => {
    const error = { code, message: "unverified payload details" };
    expect(nativeErrorText(error, createTranslator(en))).toBe(en[key]);
    expect(nativeErrorText(error, createTranslator(zhCN))).toBe(zhCN[key]);
  });
});
