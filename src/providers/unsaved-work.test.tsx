import { Activity, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/tauri";
import { toast } from "sonner";
import {
  UnsavedWorkProvider,
  UnsavedWorkScope,
  useRequestLeave,
  useUnsavedWork,
  type UnsavedWork,
} from "./unsaved-work";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  setWindowWorkState: vi.fn(async () => {}),
  respondLifecycle: vi.fn(async () => {}),
  onLifecycleRequest: vi.fn(),
  onLifecycleFinished: vi.fn(),
  onLifecycleExecuting: vi.fn(async () => () => {}),
}));
vi.mock("@/providers/i18n", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const { en } = await import("@/i18n/en");
  return { useI18n: () => ({ t: createTranslator(en), language: "en" }) };
});
function Work({ work }: { work: UnsavedWork }) {
  useUnsavedWork(work);
  return null;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function CloseTool({
  scope,
  signal,
  onResult,
}: {
  scope: string;
  signal?: AbortSignal;
  onResult: (allowed: boolean) => void;
}) {
  const requestLeave = useRequestLeave();
  return (
    <button onClick={() => void requestLeave(scope, signal).then(onResult)}>
      Close tool
    </button>
  );
}
describe("unsaved work lifecycle", () => {
  let request: ((value: native.LifecycleRequest) => void) | undefined;
  let finished: ((id: number) => void) | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(native.respondLifecycle).mockResolvedValue(undefined);
    vi.mocked(native.setWindowWorkState).mockResolvedValue(undefined);
    vi.mocked(native.onLifecycleRequest).mockImplementation(async (handler) => {
      request = handler;
      return () => {};
    });
    vi.mocked(native.onLifecycleFinished).mockImplementation(
      async (handler) => {
        finished = handler;
        return () => {};
      },
    );
  });
  afterEach(cleanup);
  it("keeps a hidden page's dirty work protected and applies discard to its retained state", async () => {
    const discarded = vi.fn();
    function RetainedPage() {
      const [draft, setDraft] = useState("unsaved connected draft");
      useUnsavedWork({
        id: "retained-draft",
        label: "Retained draft",
        dirty: draft !== "",
        discard: () => {
          discarded();
          setDraft("");
        },
      });
      return <input aria-label="Retained draft" value={draft} readOnly />;
    }
    const tree = (mode: "visible" | "hidden") => (
      <UnsavedWorkProvider>
        <Activity mode={mode}>
          <RetainedPage />
        </Activity>
      </UnsavedWorkProvider>
    );
    const view = render(tree("visible"));
    await waitFor(() => expect(native.onLifecycleRequest).toHaveBeenCalled());
    view.rerender(tree("hidden"));
    act(() => request?.({ id: 81, action: "quit", windows: ["main"] }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Retained draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and continue" }),
    );
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledWith(81, true),
    );
    expect(discarded).toHaveBeenCalledOnce();
    act(() => finished?.(81));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    view.rerender(tree("visible"));
    expect(screen.getByRole("textbox", { name: "Retained draft" })).toHaveValue(
      "",
    );
  });
  it("offers cancellation or explicit discard for a local draft and awaits discard before leaving", async () => {
    const removal = deferred();
    const discard = vi.fn(() => removal.promise);
    const result = vi.fn();
    render(
      <UnsavedWorkProvider>
        <CloseTool scope="connection" onResult={result} />
        <UnsavedWorkScope scope="connection">
          <Work
            work={{
              id: "parameters",
              label: "Parameters",
              dirty: true,
              discard,
            }}
          />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    expect(
      screen.queryByRole("button", { name: "Save and continue" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    expect(discard).not.toHaveBeenCalled();
    result.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and continue" }),
    );
    expect(discard).toHaveBeenCalledOnce();
    expect(result).not.toHaveBeenCalled();
    await act(async () => removal.resolve());
    await waitFor(() => expect(result).toHaveBeenCalledWith(true));
  });
  it("updates save availability when a dirty draft changes its persistence capability", async () => {
    const save = vi.fn(async () => {});
    const result = vi.fn();
    const work: UnsavedWork = {
      id: "editor",
      label: "Editor",
      dirty: true,
      save,
      discard: () => {},
    };
    const tree = (value: UnsavedWork) => (
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work work={value} />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>
    );
    const view = render(tree(work));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    expect(
      screen.getByRole("button", { name: "Save and continue" }),
    ).toBeEnabled();
    view.rerender(tree({ ...work, save: undefined }));
    expect(
      screen.queryByRole("button", { name: "Save and continue" }),
    ).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    view.rerender(tree(work));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(true));
    expect(save).toHaveBeenCalledOnce();
  });
  it("settles only the requested scope and leaves other work registered", async () => {
    const saved: string[] = [];
    const result = vi.fn();
    render(
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work
            work={{
              id: "editor",
              label: "Editor draft",
              dirty: true,
              save: async () => {
                saved.push("editor");
              },
              discard: () => {},
            }}
          />
        </UnsavedWorkScope>
        <UnsavedWorkScope scope="transfer">
          <Work
            work={{
              id: "transfer",
              label: "Transfer draft",
              dirty: true,
              save: async () => {
                saved.push("transfer");
              },
              discard: () => {},
            }}
          />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Editor draft");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Transfer draft");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(true));
    expect(saved).toEqual(["editor"]);
    expect(native.respondLifecycle).not.toHaveBeenCalled();
    expect(native.setWindowWorkState).toHaveBeenLastCalledWith([
      "Transfer draft",
    ]);
  });
  it("cancels a scoped close without removing the draft", async () => {
    const result = vi.fn();
    render(
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work
            work={{
              id: "editor",
              label: "Editor draft",
              dirty: true,
              save: async () => {},
              discard: () => {},
            }}
          />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Editor draft");
  });
  it("waits for scoped discard and keeps a new edit registered during save", async () => {
    const saving = deferred();
    const result = vi.fn();
    const first = {
      id: "editor",
      label: "Editor draft",
      dirty: true,
      save: () => saving.promise,
      discard: () => {},
    };
    const tree = (work: UnsavedWork) => (
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work work={work} />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>
    );
    const view = render(tree(first));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    const removal = deferred();
    view.rerender(
      tree({
        ...first,
        label: "New editor draft",
        discard: () => removal.promise,
      }),
    );
    await act(async () => saving.resolve());
    expect(result).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("New editor draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and continue" }),
    );
    expect(result).not.toHaveBeenCalled();
    await act(async () => removal.resolve());
    await waitFor(() => expect(result).toHaveBeenCalledWith(true));
  });
  it("aborts scoped waiting and ignores its late result after a native request", async () => {
    const saving = deferred();
    const result = vi.fn();
    let writes = 0;
    let saveSignal: AbortSignal | undefined;
    render(
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work
            work={{
              id: "editor",
              label: "Editor draft",
              dirty: true,
              save: (signal) => {
                saveSignal = signal;
                writes++;
                return saving.promise;
              },
              discard: () => {},
            }}
          />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    act(() => request?.({ id: 50, action: "quit", windows: ["main"] }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    expect(saveSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(writes).toBe(1);
    await act(async () => saving.resolve());
    expect(native.respondLifecycle).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Editor draft");
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and continue" }),
    );
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledWith(50, true),
    );
    expect(result).toHaveBeenCalledTimes(1);
  });
  it("resolves false on external abort and scope unmount while retaining work", async () => {
    const controller = new AbortController();
    const result = vi.fn();
    const work = {
      id: "editor",
      label: "Editor draft",
      dirty: true,
      save: async () => {},
      discard: () => {},
    };
    const tree = (show: boolean, signal?: AbortSignal) => (
      <UnsavedWorkProvider>
        <CloseTool scope="editor" signal={signal} onResult={result} />
        {show && (
          <UnsavedWorkScope scope="editor">
            <Work work={work} />
          </UnsavedWorkScope>
        )}
      </UnsavedWorkProvider>
    );
    const view = render(tree(true, controller.signal));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    act(() => controller.abort());
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(tree(true));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    view.rerender(tree(false));
    await waitFor(() => expect(result).toHaveBeenCalledTimes(2));
    expect(result).toHaveBeenLastCalledWith(false);
    act(() => request?.({ id: 60, action: "quit", windows: ["main"] }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Editor draft");
  });
  it("allows an empty scope without a dialog and rejects an already aborted caller", async () => {
    const result = vi.fn();
    const controller = new AbortController();
    const tree = (signal?: AbortSignal) => (
      <UnsavedWorkProvider>
        <CloseTool scope="empty" signal={signal} onResult={result} />
      </UnsavedWorkProvider>
    );
    const view = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    controller.abort();
    view.rerender(tree(controller.signal));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(false));
  });
  it("retains scoped work after a failed save and resolves cancellation on provider unmount", async () => {
    const result = vi.fn();
    const view = render(
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work
            work={{
              id: "editor",
              label: "Editor draft",
              dirty: true,
              save: async () => {
                throw new Error("Save rejected");
              },
              discard: () => {},
            }}
          />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save rejected");
    expect(screen.getByRole("dialog")).toHaveTextContent("Editor draft");
    expect(result).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    expect(native.respondLifecycle).not.toHaveBeenCalled();
  });
  it("keeps an aborted save locked until it settles and leaves the next close undecided", async () => {
    const saving = deferred();
    const controller = new AbortController();
    const result = vi.fn();
    let writes = 0;
    const work = {
      id: "editor",
      label: "Editor draft",
      dirty: true,
      save: () => {
        writes++;
        return saving.promise;
      },
      discard: () => {},
    };
    const tree = (signal?: AbortSignal) => (
      <UnsavedWorkProvider>
        <CloseTool scope="editor" signal={signal} onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work work={work} />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>
    );
    const view = render(tree(controller.signal));
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    act(() => controller.abort());
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    view.rerender(tree());
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    await waitFor(() => expect(result).toHaveBeenCalledTimes(2));
    expect(result.mock.calls).toEqual([[false], [false]]);
    await act(async () => saving.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Close tool" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Editor draft");
    expect(result).toHaveBeenCalledTimes(2);
    expect(writes).toBe(1);
  });
  it("rejects a scoped close while the native lifecycle owns the save", async () => {
    const saving = deferred();
    const result = vi.fn();
    let writes = 0;
    render(
      <UnsavedWorkProvider>
        <CloseTool scope="editor" onResult={result} />
        <UnsavedWorkScope scope="editor">
          <Work
            work={{
              id: "editor",
              label: "Editor draft",
              dirty: true,
              save: () => {
                writes++;
                return saving.promise;
              },
              discard: () => {},
            }}
          />
        </UnsavedWorkScope>
      </UnsavedWorkProvider>,
    );
    const close = screen.getByRole("button", { name: "Close tool" });
    act(() => request?.({ id: 70, action: "quit", windows: ["main"] }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    fireEvent.click(close);
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-lifecycle-request",
      "70",
    );
    expect(writes).toBe(1);
    await act(async () => saving.resolve());
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledWith(70, true),
    );
    expect(result).toHaveBeenCalledTimes(1);
  });
  it("reports a background subscription error once with a toast retry action and removes it on unmount", async () => {
    vi.mocked(native.onLifecycleRequest).mockRejectedValueOnce(
      new Error("Cannot listen"),
    );
    const view = render(
      <UnsavedWorkProvider>
        <span>Workspace</span>
      </UnsavedWorkProvider>,
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const [message, options] = vi.mocked(toast.error).mock.calls[0]!;
    expect(message).toBe("Operation failed: Cannot listen");
    expect(options).toMatchObject({
      duration: Infinity,
      action: { label: "Retry" },
    });
    view.rerender(
      <UnsavedWorkProvider>
        <span>Updated workspace</span>
      </UnsavedWorkProvider>,
    );
    expect(toast.error).toHaveBeenCalledOnce();
    const action = options?.action;
    if (typeof action !== "object" || action === null || !("onClick" in action))
      throw new Error("Missing toast retry action");
    act(() => action.onClick({} as React.MouseEvent<HTMLButtonElement>));
    await waitFor(() =>
      expect(native.onLifecycleRequest).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(native.setWindowWorkState).toHaveBeenCalledWith([]),
    );
    view.unmount();
    expect(toast.dismiss).toHaveBeenCalledWith(options?.id);
  });
  it("stops automatic approval after an IPC failure and allows an explicit retry", async () => {
    vi.mocked(native.respondLifecycle).mockRejectedValueOnce(
      new Error("Lifecycle response failed"),
    );
    render(<UnsavedWorkProvider>{null}</UnsavedWorkProvider>);
    act(() => request?.({ id: 1, action: "quit", windows: ["main"] }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Lifecycle response failed",
    );
    expect(native.respondLifecycle).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Save and continue" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledTimes(2),
    );
    expect(native.respondLifecycle).toHaveBeenLastCalledWith(1, true);
  });
  it("translates structured native failures while retaining unsaved work", async () => {
    render(
      <UnsavedWorkProvider>
        <Work
          work={{
            id: "notes",
            label: "Notes",
            dirty: true,
            save: vi.fn().mockRejectedValue({
              code: "STORAGE_IO",
              message: "Raw native diagnostics",
              retryable: true,
            }),
            discard: vi.fn(),
          }}
        />
      </UnsavedWorkProvider>,
    );
    act(() => request?.({ id: 1, action: "quit", windows: ["main"] }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read or write application data",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Notes");
    expect(native.respondLifecycle).not.toHaveBeenCalled();
  });
  it("ignores a failed state report after a newer report has succeeded", async () => {
    const previous = deferred();
    vi.mocked(native.setWindowWorkState).mockReturnValueOnce(previous.promise);
    const view = render(<UnsavedWorkProvider>{null}</UnsavedWorkProvider>);
    await waitFor(() =>
      expect(native.setWindowWorkState).toHaveBeenCalledWith([]),
    );
    view.rerender(
      <UnsavedWorkProvider>
        <Work
          work={{
            id: "notes",
            label: "Notes",
            dirty: true,
            save: vi.fn(),
            discard: vi.fn(),
          }}
        />
      </UnsavedWorkProvider>,
    );
    await waitFor(() =>
      expect(native.setWindowWorkState).toHaveBeenLastCalledWith(["Notes"]),
    );
    await act(async () => previous.reject(new Error("Obsolete report failed")));
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("closes on a native cancellation broadcast and ignores a delayed copy of the finished request", async () => {
    render(
      <UnsavedWorkProvider>
        <Work
          work={{
            id: "notes",
            label: "Notes",
            dirty: true,
            save: vi.fn(),
            discard: vi.fn(),
          }}
        />
      </UnsavedWorkProvider>,
    );
    act(() =>
      request?.({ id: 8, action: "quit", windows: ["main", "secondary"] }),
    );
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-lifecycle-request",
      "8",
    );
    act(() => finished?.(8));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    act(() =>
      request?.({ id: 8, action: "quit", windows: ["main", "secondary"] }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => finished?.(9));
    act(() => request?.({ id: 9, action: "quit", windows: ["main"] }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => request?.({ id: 10, action: "quit", windows: ["main"] }));
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-lifecycle-request",
      "10",
    );
  });
  it("retains work after leaving the page and waits for its save before approving", async () => {
    const saving = deferred();
    const save = vi.fn<(signal?: AbortSignal) => Promise<void>>(
      () => saving.promise,
    );
    const work = {
      id: "notes",
      label: "Notes",
      dirty: true,
      save,
      discard: vi.fn(),
    };
    const view = render(
      <UnsavedWorkProvider>
        <Work work={work} />
      </UnsavedWorkProvider>,
    );
    await waitFor(() =>
      expect(native.setWindowWorkState).toHaveBeenCalledWith(["Notes"]),
    );
    view.rerender(
      <UnsavedWorkProvider>
        <span>Another page</span>
      </UnsavedWorkProvider>,
    );
    act(() =>
      request?.({ id: 7, action: "quit", windows: ["main", "secondary"] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(save).toHaveBeenCalledOnce();
    const signal = save.mock.calls[0]?.[0];
    act(() =>
      request?.({ id: 7, action: "quit", windows: ["main", "secondary"] }),
    );
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    const status = screen
      .getByRole("dialog")
      .querySelector("[data-lifecycle-status]");
    expect(status).toHaveTextContent("Saving…");
    expect(native.respondLifecycle).not.toHaveBeenCalled();
    await act(async () => saving.resolve());
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledWith(7, true),
    );
    expect(
      screen.getByRole("dialog").querySelector("[data-lifecycle-status]"),
    ).toBe(status);
    expect(status).toHaveTextContent("Waiting");
  });
  it("keeps failed work and the dialog open, then allows cancellation", async () => {
    const save = vi.fn(async () => {
      throw new Error("Disk is full");
    });
    render(
      <UnsavedWorkProvider>
        <Work
          work={{
            id: "files",
            label: "Files",
            dirty: true,
            save,
            discard: vi.fn(),
          }}
        />
      </UnsavedWorkProvider>,
    );
    act(() =>
      request?.({ id: 2, action: "install-update", windows: ["main"] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full");
    expect(native.respondLifecycle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledWith(2, false),
    );
    expect(native.setWindowWorkState).toHaveBeenLastCalledWith(["Files"]);
  });
  it("awaits durable draft removal before approving discard", async () => {
    const removing = deferred();
    const discard = vi.fn(() => removing.promise);
    render(
      <UnsavedWorkProvider>
        <Work
          work={{
            id: "notes",
            label: "Notes",
            dirty: true,
            save: vi.fn(),
            discard,
          }}
        />
      </UnsavedWorkProvider>,
    );
    act(() => request?.({ id: 3, action: "close", windows: ["secondary"] }));
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and continue" }),
    );
    expect(discard).toHaveBeenCalledOnce();
    expect(native.respondLifecycle).not.toHaveBeenCalled();
    await act(async () => removing.resolve());
    await waitFor(() =>
      expect(native.respondLifecycle).toHaveBeenCalledWith(3, true),
    );
  });
});
