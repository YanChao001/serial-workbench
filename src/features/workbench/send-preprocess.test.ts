import { expect, it, vi } from "vitest";
import { runSendPreprocess } from "./send-preprocess";

it("transcodes the source before wrapping the exact bytes as JSON", async () => {
  const input = Uint8Array.of(0x41, 0xc3, 0xa9);
  const output = await runSendPreprocess(
    input,
    JSON.stringify([
      { kind: "encoding", from: "utf-8", to: "utf-16le" },
      { kind: "json", field: "body", format: "base64" },
    ]),
    new AbortController().signal,
  );

  expect(new TextDecoder().decode(output)).toBe('{"body":"QQDpAA=="}');
  expect(input).toEqual(Uint8Array.of(0x41, 0xc3, 0xa9));
});

it("passes only the configured parameters and current bytes to the selected query", async () => {
  const signal = new AbortController().signal;
  const query = vi.fn().mockResolvedValue({ output: "/wA=", unrelated: true });
  const output = await runSendPreprocess(
    Uint8Array.of(0x01, 0x02),
    JSON.stringify([
      {
        kind: "query",
        actionId: "test.preprocess.bytes",
        input: "source",
        output: "output",
        params: { variant: "one" },
      },
      { kind: "json", field: "body", format: "base64" },
    ]),
    signal,
    query,
  );

  expect(query).toHaveBeenCalledExactlyOnceWith(
    "test.preprocess.bytes",
    { variant: "one", source: "AQI=" },
    signal,
  );
  expect(new TextDecoder().decode(output)).toBe('{"body":"/wA="}');
});

const extensionStep = {
  kind: "query",
  actionId: "test.preprocess.bytes",
  input: "source",
  output: "output",
};

it("rejects invalid UTF-8 rather than wrapping replacement characters", async () => {
  await expect(
    runSendPreprocess(
      Uint8Array.of(0xff),
      JSON.stringify([{ kind: "json", field: "body", format: "text" }]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "encoding", step: 1 });
});

it("stops before the next query when a step returns invalid Base64", async () => {
  const query = vi.fn().mockResolvedValue({ output: "AQ" });
  await expect(
    runSendPreprocess(
      Uint8Array.of(0x01),
      JSON.stringify([extensionStep, extensionStep]),
      new AbortController().signal,
      query,
    ),
  ).rejects.toMatchObject({ reason: "output", step: 1 });
  expect(query).toHaveBeenCalledOnce();
});

it("discards the result and skips later steps when the preview is cancelled", async () => {
  const controller = new AbortController();
  let finish!: (value: unknown) => void;
  const query = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = runSendPreprocess(
    Uint8Array.of(0x01),
    JSON.stringify([extensionStep, extensionStep]),
    controller.signal,
    query,
  );
  controller.abort();
  finish({ output: "Ag==" });

  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(query).toHaveBeenCalledOnce();
});
