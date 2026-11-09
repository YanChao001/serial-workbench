import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";

export const allowControlActions: HostContextValue["watchActions"] = (
  inputs,
  listener,
) => {
  listener(
    inputs.map((input) => ({
      input,
      result: { actionId: input.actionId, target: input.target, allowed: true },
      error: null,
    })),
  );
  return () => {};
};

export function observeControlActions() {
  const subscriptions: {
    inputs: readonly HostActionCheckInput[];
    listener: (values: readonly HostActionAvailability[]) => void;
    stopped: boolean;
  }[] = [];
  const watchActions: HostContextValue["watchActions"] = (inputs, listener) => {
    const subscription = { inputs, listener, stopped: false };
    subscriptions.push(subscription);
    return () => {
      subscription.stopped = true;
    };
  };
  function publish(
    subscription: (typeof subscriptions)[number],
    allowed: (input: HostActionCheckInput) => boolean | null,
  ) {
    subscription.listener(
      subscription.inputs.map((input) => {
        const value = allowed(input);
        return {
          input,
          result:
            value === null
              ? null
              : {
                  actionId: input.actionId,
                  target: input.target,
                  allowed: value,
                },
          error: null,
        };
      }),
    );
  }
  return { watchActions, subscriptions, publish };
}

export const target = {
  hostId: "host",
  kind: "session" as const,
  id: "session",
  sessionId: "session",
  sessionEpoch: "1",
};
export const controlLabels = {
  sessionControls: "Session controls",
  configuration: "Requested configuration",
  baudRate: "Baud rate",
  baudPresets: "Baud presets",
  dataBits: "Data bits",
  parity: "Parity",
  stopBits: "Stop bits",
  flowControl: "Flow control",
  readWaitMs: "Read wait (ms)",
  writeWaitMs: "Write wait (ms)",
  reconnectBackoffMs: "Reconnect backoff (ms)",
  applyConfiguration: "Apply configuration",
  resetConfiguration: "Reset configuration",
  invalidConfiguration:
    "Enter positive integer values within the supported range",
  configurationSupport:
    "Driver support varies by combination; rejected fields appear in the receipt.",
  controlLines: "Control lines",
  dtrOn: "DTR on",
  dtrOff: "DTR off",
  rtsOn: "RTS on",
  rtsOff: "RTS off",
  flowOwnsLine: "Flow control owns the corresponding line",
  breakDuration: "BREAK duration (ms)",
  finiteBreak: "Finite BREAK",
  purgeDirection: "Purge direction",
  purgeScope: "Purge scope",
  purge: "Purge queues",
  drain: "Drain",
  throughOperation: "Through operation",
  queueWaitMs: "Queue wait (ms)",
  waitBoundary: "Wait boundary",
  inputSignals: "Actual input samples",
  refreshInputs: "Refresh inputs",
  sampledAt: "Sampled at",
  on: "On",
  off: "Off",
  inputSignalsUnavailable: "CTS / DSR / RI / CD sampling is unavailable",
  waitOutcome:
    "Stopping a wait leaves the line outcome unconfirmed; inspect the receipt.",
  requested: "Requested",
  actual: "Actual",
  unknown: "unknown",
  field: "Field",
  status: "Status",
  readback: "Driver readback",
  configurationReceipt: "Configuration receipt",
  controlReceipt: "Control receipt",
  breakReceipt: "BREAK receipt",
  receipt: "Receipt",
  unavailable: "Unavailable",
  readOnly: "Read only",
  gate: "Gate",
  rx: "RX",
  tx: "TX",
  both: "Both",
  application: "Application",
  driver: "Driver",
  none: "None",
  even: "Even",
  odd: "Odd",
  mark: "Mark",
  space: "Space",
  one: "1",
  onePointFive: "1.5",
  two: "2",
  rtsCts: "RTS/CTS",
  xonXoff: "XON/XOFF",
  dsrDtr: "DSR/DTR",
};
