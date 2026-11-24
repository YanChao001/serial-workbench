import type {
  NodeRegister,
  TransportConnection,
  TransportLineControls,
  TransportLineResult,
  TransportOpenOptions,
} from "@serial-workbench/plugin-sdk/node";
import { connectTcp } from "../reference-transport/tcp-transport.ts";
import {
  rfc2217LineCodes,
  rfc2217Settings,
  type SettingRequest,
} from "./settings.ts";
import {
  encodeSub,
  encodeTelnetData,
  TelnetDecoder,
  telnet,
  type TelnetItem,
} from "./telnet.ts";

export const rfc2217TransportId = "reference.rfc2217.transport";
const openWaitMs = 3000;
const maxBufferedBytes = 64 * 1024;
const wireReadBytes = 4096;

type LiveControl = { on: number; off: number; sent: boolean; actual?: boolean };

type FailureKind = "refused" | "different_value" | "timeout" | "disconnected";
export class Rfc2217NegotiationError extends Error {
  readonly reason: FailureKind;
  readonly field: string;
  readonly requestedHex?: string;
  readonly replyHex?: string;

  constructor(
    reason: FailureKind,
    field: string,
    requestedHex?: string,
    replyHex?: string,
  ) {
    super("RFC 2217 " + field + " " + reason);
    this.name = "Rfc2217NegotiationError";
    this.reason = reason;
    this.field = field;
    this.requestedHex = requestedHex;
    this.replyHex = replyHex;
  }
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export async function openRfc2217({
  params,
  signal,
}: TransportOpenOptions): Promise<TransportConnection> {
  const { host, port, requests, hardwareFlow } = rfc2217Settings(params);
  const timer = AbortSignal.timeout(openWaitMs);
  const until = performance.now() + openWaitMs;
  const remaining = (deadline: number) =>
    Math.max(0, Math.ceil(deadline - performance.now()));
  const opening = AbortSignal.any([signal, timer]);
  const decoder = new TelnetDecoder();
  const options = new Set<string>();
  const answered = new Set<number>();
  const optionReplies: Uint8Array[] = [];
  let buffered: Uint8Array = new Uint8Array();
  let request: SettingRequest | undefined;
  let confirmed = false;
  let suspended = false;
  let liveControl: LiveControl | undefined;
  let wire: TransportConnection | undefined;

  function negotiationFailure(
    reason: FailureKind,
    field = request?.field ?? "options",
    reply?: Uint8Array,
  ) {
    return new Rfc2217NegotiationError(
      reason,
      field,
      request?.field === field ? hex(request.value) : undefined,
      reply && hex(reply),
    );
  }

  try {
    wire = await connectTcp(host, port, opening);
    const connection = wire;
    async function command(
      bytes: Uint8Array,
      waitMs: number,
      signal: AbortSignal,
    ) {
      const count = await connection.write({ bytes, waitMs, signal });
      if (count !== bytes.length) throw negotiationFailure("disconnected");
    }

    function receiveOption(item: Extract<TelnetItem, { kind: "option" }>) {
      const { verb, option } = item;
      if (option === telnet.binary) {
        if (verb === telnet.will) options.add("rx");
        else if (verb === telnet.do) options.add("tx");
        else
          throw negotiationFailure(
            "refused",
            "binary",
            Uint8Array.of(verb, option),
          );
        return;
      }
      if (option === telnet.comPort) {
        if (verb === telnet.do) {
          options.add("com");
          return;
        }
        if (verb === telnet.dont)
          throw negotiationFailure(
            "refused",
            "comPort",
            Uint8Array.of(verb, option),
          );
      }
      if (verb !== telnet.will && verb !== telnet.do) return;
      const replyKey = option * 256 + verb;
      if (answered.has(replyKey)) return;
      answered.add(replyKey);
      const supported =
        option === telnet.suppressGoAhead || option === telnet.comPort;
      const reply =
        verb === telnet.will
          ? supported
            ? telnet.do
            : telnet.dont
          : supported
            ? telnet.will
            : telnet.wont;
      optionReplies.push(Uint8Array.of(telnet.iac, reply, option));
    }

    async function readWire(deadline: number, signal: AbortSignal) {
      const data = await connection.read({
        maxBytes: wireReadBytes,
        waitMs: remaining(deadline),
        signal,
      });
      if (data === null) {
        decoder.finish();
        return false;
      }
      for (const item of decoder.push(data)) {
        if (item.kind === "option") {
          receiveOption(item);
        } else if (item.kind === "sub" && item.option === telnet.comPort) {
          const [replyCode, ...values] = item.bytes;
          if (values.length === 0 && (replyCode === 108 || replyCode === 109))
            suspended = replyCode === 108;
          if (replyCode === 105 && liveControl?.sent) {
            if (values.length !== 1)
              throw new Error("Invalid RFC 2217 control reply");
            const value = values[0];
            if (value === liveControl.on || value === liveControl.off) {
              liveControl.actual ??= value === liveControl.on;
            }
          }
          if (request && replyCode === request.command + 100) {
            const reply = Uint8Array.from(values);
            if (!Buffer.from(reply).equals(request.value))
              throw negotiationFailure("different_value", request.field, reply);
            confirmed = true;
          }
        } else if (item.kind === "data" && options.size === 3) {
          if (buffered.length + item.bytes.length > maxBufferedBytes)
            throw new Error("RFC 2217 reception exceeded its startup buffer");
          buffered = Buffer.concat([buffered, item.bytes]);
        }
      }
      if (!suspended) {
        for (const reply of optionReplies.splice(0))
          await command(reply, remaining(deadline), signal);
      }
      return true;
    }

    async function waitFor(predicate: () => boolean) {
      while (!predicate()) {
        opening.throwIfAborted();
        const wait = remaining(until);
        if (wait === 0) throw negotiationFailure("timeout");
        if (!(await readWire(until, opening)))
          throw negotiationFailure("disconnected");
      }
    }
    await command(
      Uint8Array.of(
        telnet.iac,
        telnet.will,
        telnet.binary,
        telnet.iac,
        telnet.do,
        telnet.binary,
        telnet.iac,
        telnet.will,
        telnet.comPort,
      ),
      remaining(until),
      opening,
    );
    await waitFor(() => options.size === 3);

    for (const setting of requests) {
      request = setting;
      await waitFor(() => !suspended);
      confirmed = false;
      await command(
        encodeSub(
          telnet.comPort,
          Uint8Array.of(setting.command, ...setting.value),
        ),
        remaining(until),
        opening,
      );
      await waitFor(() => confirmed);
    }
    request = undefined;
    opening.throwIfAborted();

    const closing = new AbortController();
    const connected = AbortSignal.any([signal, closing.signal]);
    let readTurn: Promise<boolean> | undefined;

    function pollWire(deadline: number): Promise<boolean> {
      // 同一个 TCP 字节流始终由一个读轮次解码。控制等待和 Raw 读取共享它。
      readTurn ??= readWire(
        Math.min(deadline, performance.now() + 25),
        connected,
      ).finally(() => {
        readTurn = undefined;
      });
      return readTurn;
    }

    async function close() {
      closing.abort();
      await connection.close();
    }

    async function setLine({
      line,
      value,
      waitMs,
      signal,
    }: Parameters<
      TransportLineControls["set"]
    >[0]): Promise<TransportLineResult> {
      if (
        signal.aborted ||
        connected.aborted ||
        waitMs === 0 ||
        liveControl ||
        (line === "rts" && hardwareFlow)
      )
        return { kind: "not_applied" };
      const deadline = performance.now() + waitMs;
      const codes = rfc2217LineCodes[line];
      const control: LiveControl = { ...codes, sent: false };
      liveControl = control;
      try {
        // 先处理已到达的暂停或断开，等待恢复期间不会提交命令。
        if (!(await pollWire(performance.now())))
          return { kind: "not_applied" };
        while (suspended && remaining(deadline) > 0 && !signal.aborted) {
          if (!(await pollWire(deadline))) return { kind: "not_applied" };
        }
        if (
          signal.aborted ||
          connected.aborted ||
          suspended ||
          remaining(deadline) === 0
        )
          return { kind: "not_applied" };

        control.sent = true;
        await command(
          encodeSub(
            telnet.comPort,
            Uint8Array.of(5, value ? codes.on : codes.off),
          ),
          remaining(deadline),
          AbortSignal.any([connected, signal]),
        );
        while (
          control.actual === undefined &&
          remaining(deadline) > 0 &&
          !signal.aborted &&
          !connected.aborted
        ) {
          if (!(await pollWire(deadline))) break;
        }
        if (control.actual === undefined)
          throw new Error("RFC 2217 line result is unknown");
        return { kind: "confirmed", actual: control.actual };
      } catch (error) {
        if (!control.sent) return { kind: "not_applied" };
        await close();
        throw error;
      } finally {
        liveControl = undefined;
      }
    }

    return {
      lineControls: { dtr: true, rts: !hardwareFlow, set: setLine },
      async read({ maxBytes, waitMs, signal }) {
        signal.throwIfAborted();
        const deadline = performance.now() + waitMs;
        try {
          if (buffered.length === 0) {
            do {
              if (!(await pollWire(deadline))) return null;
              signal.throwIfAborted();
            } while (buffered.length === 0 && remaining(deadline) > 0);
          }
          const bytes = buffered.subarray(0, maxBytes);
          buffered = buffered.subarray(bytes.length);
          return bytes;
        } catch (error) {
          if (!signal.aborted) await close();
          throw error;
        }
      },
      async write({ bytes, waitMs, signal }) {
        signal.throwIfAborted();
        if (suspended || connected.aborted) return 0;
        const encoded = encodeTelnetData(bytes);
        const count = await connection.write({
          bytes: encoded,
          waitMs,
          signal,
        });
        if (count === 0) return 0;
        if (count !== encoded.length) {
          await close();
          throw new Error(
            "RFC 2217 write did not confirm the complete Telnet frame",
          );
        }
        return bytes.length;
      },
      close,
    };
  } catch (error) {
    await wire?.close();
    if (error instanceof Rfc2217NegotiationError) throw error;
    if (timer.aborted && !signal.aborted) throw negotiationFailure("timeout");
    throw error;
  }
}

export const registerRfc2217Transport =
  (providerId: string): NodeRegister =>
  (context) => {
    const lifetime = new AbortController();
    const pending = new Set<Promise<TransportConnection>>();
    context.transports.register(providerId, async ({ params, signal }) => {
      const opening = openRfc2217({
        params,
        signal: AbortSignal.any([signal, lifetime.signal]),
      });
      pending.add(opening);
      try {
        const connection = await opening;
        return {
          ...connection,
          async close() {
            await connection.close();
            pending.delete(opening);
          },
        };
      } catch (error) {
        pending.delete(opening);
        throw error;
      }
    });
    return async () => {
      lifetime.abort();
      const settled = await Promise.allSettled(pending);
      await Promise.all(
        settled.flatMap((item) =>
          item.status === "fulfilled" ? [item.value.close()] : [],
        ),
      );
      pending.clear();
    };
  };

export const register = registerRfc2217Transport(rfc2217TransportId);
