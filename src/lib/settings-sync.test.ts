// @vitest-environment node
import {
  defaults,
  type SharedSettings,
  type SettingsSnapshot,
} from "@serial-workbench/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  SettingsSync,
  type SettingsBackend,
  type SettingsState,
} from "./settings-sync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function snapshot(
  revision = "3",
  patch: Partial<SharedSettings> = {},
): SettingsSnapshot {
  return { revision, value: { ...defaults.settings, ...patch } };
}
function store() {
  let current = snapshot();
  const listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  const writes: SharedSettings[] = [];
  const backend: SettingsBackend = {
    async read() {
      return current;
    },
    async save(value, revision) {
      if (revision !== current.revision) throw { code: "REVISION_CONFLICT" };
      writes.push(value);
      current = { revision: String(BigInt(revision) + 1n), value };
      return current;
    },
    async subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    backend,
    writes,
    listeners,
    remote(value: SettingsSnapshot) {
      current = value;
      for (const listener of listeners) listener(current);
    },
  };
}
function setup(backend: SettingsBackend) {
  const states: SettingsState[] = [];
  const sync = new SettingsSync(defaults.settings, backend, (state) =>
    states.push(state),
  );
  return { sync, states, latest: () => states.at(-1)! };
}

describe("Host shared settings synchronization", () => {
  it("reconnects a failed subscription on retry and ignores the retired listener", async () => {
    const host = store();
    const subscriptions: Array<{
      snapshot(value: SettingsSnapshot): void;
      failed(error: unknown): void;
    }> = [];
    const env = setup({
      ...host.backend,
      subscribe: async (snapshot, failed) => {
        subscriptions.push({ snapshot, failed: failed! });
        return () => {};
      },
    });
    await env.sync.start();
    subscriptions[0]!.failed({ code: "CHANNEL_FAILED" });
    expect(env.latest().error).toBe("CHANNEL_FAILED");
    await env.sync.retry();
    expect(subscriptions).toHaveLength(2);
    subscriptions[0]!.snapshot(snapshot("10", { language: "en" }));
    expect(env.latest().settings.language).toBe("zh");
    subscriptions[1]!.snapshot(snapshot("4", { language: "en" }));
    expect(env.latest().settings.language).toBe("en");
    env.sync.stop();
  });
  it("retains the losing client's unsubmitted patch until explicit retry", async () => {
    const host = store();
    const first = setup(host.backend);
    const second = setup(host.backend);
    await Promise.all([first.sync.start(), second.sync.start()]);
    first.sync.update({ accent: "rose" });
    second.sync.update({ font: "mono" });
    await vi.waitFor(() =>
      expect(second.latest().error).toBe("REVISION_CONFLICT"),
    );
    expect(host.writes).toHaveLength(1);
    expect(second.latest().settings.font).toBe("mono");
    host.remote(snapshot("4", { accent: "rose" }));
    expect(second.latest().settings).toMatchObject({
      accent: "rose",
      font: "mono",
    });
    expect(host.writes).toHaveLength(1);
    await second.sync.retry();
    await vi.waitFor(() => expect(second.latest().status).toBe("saved"));
    expect(host.writes.at(-1)).toMatchObject({ accent: "rose", font: "mono" });
    first.sync.stop();
    second.sync.stop();
  });

  it("does not overwrite edits made during an in-flight save or newer external snapshots", async () => {
    const host = store();
    const write = deferred<SettingsSnapshot>();
    let first = true;
    const backend: SettingsBackend = {
      ...host.backend,
      save: (value, revision) => {
        if (first) {
          first = false;
          return write.promise;
        }
        return host.backend.save(value, revision);
      },
    };
    const env = setup(backend);
    await env.sync.start();
    env.sync.update({ font: "mono" });
    env.sync.update({ font: "serif" });
    host.remote(snapshot("5", { accent: "cyan" }));
    expect(env.latest().settings).toMatchObject({
      font: "serif",
      accent: "cyan",
    });
    expect(env.latest().revision).toBe("5");
    write.resolve(snapshot("4", { font: "mono" }));
    await vi.waitFor(() => expect(env.latest().status).toBe("saved"));
    expect(host.writes.at(-1)).toMatchObject({ font: "serif", accent: "cyan" });
    env.sync.stop();
  });

  it.each(["FUTURE_FORMAT", "INVALID_DOCUMENT", "UNKNOWN_FIELD"])(
    "preserves draft and never writes after unreadable %s",
    async (code) => {
      const host = store();
      const env = setup({
        ...host.backend,
        read: async () => {
          throw { code };
        },
      });
      env.sync.update({ theme: "light" });
      await env.sync.start();
      expect(env.latest()).toMatchObject({
        status: "error",
        error: code,
        settings: { theme: "light" },
      });
      await env.sync.retry();
      expect(host.writes).toHaveLength(0);
      await expect(env.sync.replace(defaults.settings)).rejects.toMatchObject({
        code,
      });
      expect(env.sync.stop()).toEqual({ theme: "light" });
    },
  );

  it("uses lossless U64 document revisions beyond Number precision", async () => {
    const host = store();
    host.remote(snapshot("9007199254740993"));
    const env = setup(host.backend);
    await env.sync.start();
    env.sync.update({ language: "en" });
    await vi.waitFor(() => expect(env.latest().status).toBe("saved"));
    expect((await host.backend.read()).revision).toBe("9007199254740994");
    env.sync.stop();
  });

  it("deduplicates initialization and closes a late subscription without reading or publishing", async () => {
    const subscribed = deferred<() => void>();
    let closed = 0;
    let reads = 0;
    const host = store();
    const env = setup({
      ...host.backend,
      read: async () => {
        reads++;
        return snapshot();
      },
      subscribe: () => subscribed.promise,
    });
    const first = env.sync.start();
    const second = env.sync.start();
    await Promise.resolve();
    env.sync.update({ theme: "light" });
    expect(env.sync.stop()).toEqual({ theme: "light" });
    const count = env.states.length;
    subscribed.resolve(() => {
      closed++;
    });
    await Promise.all([first, second]);
    expect(closed).toBe(1);
    expect(reads).toBe(0);
    expect(env.states).toHaveLength(count);
  });

  it("ignores a load completing after unmount", async () => {
    const read = deferred<SettingsSnapshot>();
    const host = store();
    const env = setup({ ...host.backend, read: () => read.promise });
    const start = env.sync.start();
    await vi.waitFor(() => expect(host.listeners.size).toBe(1));
    env.sync.stop();
    const count = env.states.length;
    read.resolve(snapshot("4", { theme: "light" }));
    await start;
    expect(host.listeners.size).toBe(0);
    expect(env.states).toHaveLength(count);
  });
});
