import type { SendHistoryPin } from "./generated/bindings";
import {
  parseSendHistoryPins,
  readClientWindowState,
  saveClientWindowState,
  type ClientSettingsPort,
} from "./client-settings";
import { settingsErrorCode } from "./settings-sync";

export type SendHistoryPinScope = Pick<
  SendHistoryPin,
  "hostId" | "workspaceId"
>;

function inScope(pin: SendHistoryPin, scope: SendHistoryPinScope) {
  return pin.hostId === scope.hostId && pin.workspaceId === scope.workspaceId;
}

function pinnedIds(pins: SendHistoryPin[], scope: SendHistoryPinScope) {
  return new Set(
    pins.filter((pin) => inScope(pin, scope)).map((pin) => pin.operationId),
  );
}

export function createSendHistoryPinStore(
  port: ClientSettingsPort = {
    read: readClientWindowState,
    save: saveClientWindowState,
  },
) {
  async function readState(signal: AbortSignal) {
    signal.throwIfAborted();
    const snapshot = await port.read();
    signal.throwIfAborted();
    if (snapshot.formatVersion !== "0.1") throw { code: "FUTURE_FORMAT" };
    return snapshot;
  }
  return {
    async read(scope: SendHistoryPinScope, signal: AbortSignal) {
      const snapshot = await readState(signal);
      return pinnedIds(
        parseSendHistoryPins(snapshot.state.sendHistoryPins ?? []),
        scope,
      );
    },
    async set(
      scope: SendHistoryPinScope,
      operationId: string,
      pinned: boolean,
      signal: AbortSignal,
    ) {
      for (let attempt = 0; ; attempt++) {
        const base = await readState(signal);
        const pins = parseSendHistoryPins(base.state.sendHistoryPins ?? []);
        const remaining = pins.filter(
          (pin) => !inScope(pin, scope) || pin.operationId !== operationId,
        );
        const alreadyPinned = remaining.length !== pins.length;
        if (pinned === alreadyPinned) return pinnedIds(pins, scope);
        const sendHistoryPins = parseSendHistoryPins(
          pinned ? [...remaining, { ...scope, operationId }] : remaining,
        );
        try {
          const saved = await port.save(
            { ...base.state, sendHistoryPins },
            base.revision,
          );
          signal.throwIfAborted();
          if (saved.formatVersion !== "0.1") throw { code: "FUTURE_FORMAT" };
          return pinnedIds(
            parseSendHistoryPins(saved.state.sendHistoryPins ?? []),
            scope,
          );
        } catch (error) {
          if (
            signal.aborted ||
            settingsErrorCode(error) !== "CONFLICT" ||
            attempt === 2
          )
            throw error;
        }
      }
    },
  };
}
