import type { SerialConfiguration } from "@serial-workbench/contracts";
import type { ConnectionDefault, WriteWaitMode } from "./generated/bindings";
import type {
  ClientSettingsPort,
  ClientStateSnapshot,
} from "./client-settings";
import { parseConnectionDefaults } from "./client-settings";
import type { SettingsBackend } from "./settings-sync";
import { settingsErrorCode } from "./settings-sync";

export type ConnectionConfigurations = Record<string, SerialConfiguration>;
export type ConnectionSetting = {
  configuration: SerialConfiguration;
  writeWaitMode: WriteWaitMode;
};
export type ConnectionDefaults = Record<string, ConnectionSetting>;
export function connectionKey(hostId: string, deviceId: string): string {
  return JSON.stringify([hostId, deviceId]);
}
function values(entries: ConnectionDefault[]): ConnectionDefaults {
  return Object.fromEntries(
    entries.map((entry) => [
      connectionKey(entry.hostId, entry.deviceId),
      {
        configuration: entry.configuration,
        writeWaitMode: entry.writeWaitMode ?? "automatic",
      },
    ]),
  );
}
export function sameConnectionConfiguration(
  left: SerialConfiguration | undefined,
  right: SerialConfiguration | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (Object.keys(left) as Array<keyof SerialConfiguration>).every(
    (key) => left[key] === right[key],
  );
}
function entries(value: ConnectionDefaults): ConnectionDefault[] {
  return parseConnectionDefaults(
    Object.entries(value).map(([key, setting]) => {
      const target: unknown = JSON.parse(key);
      if (!Array.isArray(target) || target.length !== 2)
        throw { code: "INVALID_ARGUMENT" };
      return {
        hostId: target[0],
        deviceId: target[1],
        configuration: setting.configuration,
        ...(setting.writeWaitMode === "fixed"
          ? { writeWaitMode: "fixed" }
          : {}),
      };
    }),
  );
}
export function sameConnectionSetting(
  left: ConnectionSetting | undefined,
  right: ConnectionSetting | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.writeWaitMode === right.writeWaitMode &&
    sameConnectionConfiguration(left.configuration, right.configuration)
  );
}
/** 合并当前设备的默认参数，保留草稿、偏好、图库和其他设备的并发更新。 */
export function createConnectionDefaultsBackend(
  port: ClientSettingsPort,
): SettingsBackend<ConnectionDefaults> {
  let current: ClientStateSnapshot | undefined;
  const readValues = (snapshot: ClientStateSnapshot) => {
    if (snapshot.formatVersion !== "0.1") throw { code: "FUTURE_FORMAT" };
    return values(
      parseConnectionDefaults(snapshot.state.connectionDefaults ?? []),
    );
  };
  const accept = (snapshot: ClientStateSnapshot) => {
    const value = readValues(snapshot);
    current = snapshot;
    return { revision: snapshot.revision, value };
  };
  return {
    async read() {
      return accept(await port.read());
    },
    async save(value, revision) {
      if (!current || current.revision !== revision) throw { code: "CONFLICT" };
      const original = readValues(current);
      const changed = Object.keys(value).filter(
        (key) => !sameConnectionSetting(value[key], original[key]),
      );
      if (!changed.length) return accept(current);
      let base = current;
      for (let attempt = 0; ; attempt++) {
        const freshValues = readValues(base);
        const merged = {
          ...freshValues,
          ...Object.fromEntries(
            changed.map((key) => {
              const configuration = value[key];
              if (!configuration) throw { code: "INVALID_ARGUMENT" };
              return [key, configuration];
            }),
          ),
        };
        const connectionDefaults = entries(merged);
        try {
          return accept(
            await port.save(
              { ...base.state, connectionDefaults },
              base.revision,
            ),
          );
        } catch (error) {
          if (settingsErrorCode(error) !== "CONFLICT" || attempt === 2)
            throw error;
          const fresh = await port.read();
          const incoming = readValues(fresh);
          if (
            changed.every((key) =>
              sameConnectionSetting(incoming[key], value[key]),
            )
          )
            return accept(fresh);
          if (
            changed.some(
              (key) =>
                !sameConnectionSetting(incoming[key], original[key]) &&
                !sameConnectionSetting(incoming[key], value[key]),
            )
          )
            throw error;
          base = fresh;
        }
      }
    },
    async subscribe() {
      return () => {};
    },
  };
}
