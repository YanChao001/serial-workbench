import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createDraftStore } from "./draft-store";
import { WorkspaceSendPanel } from "./workspace-send-panel";
import { labels, operation, session } from "./test-fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("updates current draft text while the workspace only observes dirty state transitions", () => {
  const drafts = createDraftStore({ first: "", second: "keep" });
  let parentRenders = 0;
  function Workspace() {
    useSyncExternalStore(drafts.subscribe, drafts.isDirty, drafts.isDirty);
    parentRenders++;
    return (
      <WorkspaceSendPanel
        drafts={drafts}
        draftKey="first"
        labels={labels}
        onSend={vi.fn()}
      />
    );
  }
  render(<Workspace />);
  const input = screen.getByRole("textbox", { name: labels.draft });
  fireEvent.change(input, { target: { value: "0" } });
  const afterFirstEdit = parentRenders;
  for (let count = 2; count <= 20; count++)
    fireEvent.change(input, { target: { value: "0".repeat(count) } });
  expect(input).toHaveValue("0".repeat(20));
  expect(drafts.get("first")).toBe("0".repeat(20));
  expect(drafts.get("second")).toBe("keep");
  expect(parentRenders).toBe(afterFirstEdit);
});

it("preserves native selection and composition while syncing external draft resets and view changes", () => {
  const drafts = createDraftStore({ first: "before", second: "other view" });
  const send = vi.fn();
  const props = { drafts, labels, onSend: send, session: session() };
  const view = render(<WorkspaceSendPanel {...props} draftKey="first" />);
  const input = screen.getByRole("textbox", { name: labels.draft });
  if (!(input instanceof HTMLTextAreaElement))
    throw new Error("Missing draft input");
  input.focus();
  input.setSelectionRange(1, 3);
  view.rerender(<WorkspaceSendPanel {...props} draftKey="first" />);
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);

  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "中文草稿" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
  expect(send).not.toHaveBeenCalled();
  expect(input).toHaveValue("中文草稿");
  expect(drafts.get("first")).toBe("中文草稿");
  fireEvent.compositionEnd(input, { data: "中文草稿" });

  act(() => drafts.discard());
  expect(input).toHaveValue("before");
  view.rerender(<WorkspaceSendPanel {...props} draftKey="second" />);
  expect(input).toHaveValue("other view");
  act(() => drafts.change("second", "externally replaced"));
  expect(input).toHaveValue("externally replaced");
});

it("coalesces permission previews and clears only the current local draft with focus restored", () => {
  vi.useFakeTimers();
  const drafts = createDraftStore({ first: "A", second: "keep" });
  const observed = vi.fn();
  render(
    <WorkspaceSendPanel
      drafts={drafts}
      draftKey="first"
      labels={labels}
      onSend={vi.fn()}
      onPreviewChange={observed}
    />,
  );
  const input = screen.getByRole("textbox", { name: labels.draft });
  for (const value of ["AB", "ABC", "latest"])
    fireEvent.change(input, { target: { value } });
  act(() => vi.advanceTimersByTime(149));
  expect(observed.mock.calls.filter(([bytes]) => bytes !== null)).toHaveLength(
    0,
  );
  act(() => vi.advanceTimersByTime(1));
  expect(observed).toHaveBeenLastCalledWith(new TextEncoder().encode("latest"));
  fireEvent.change(input, { target: { value: "pending" } });
  fireEvent.click(screen.getByRole("button", { name: labels.clearDraft }));
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(
    screen.getByRole("button", { name: labels.clearDraft }),
  ).toBeDisabled();
  expect(drafts.snapshot()).toEqual({ first: "", second: "keep" });
  expect(screen.getByLabelText(labels.draftByteCount)).toHaveTextContent("0 B");
  act(() => vi.advanceTimersByTime(500));
  expect(observed.mock.calls.filter(([bytes]) => bytes !== null)).toHaveLength(
    1,
  );
  expect(observed).toHaveBeenLastCalledWith(null);
});

it("sends the current view immediately and cancels the previous view's pending preview", async () => {
  vi.useFakeTimers();
  const drafts = createDraftStore({ first: "A", second: "B" });
  const observed = vi.fn();
  const send = vi.fn().mockResolvedValue(operation());
  const props = {
    drafts,
    labels,
    onSend: send,
    onPreviewChange: observed,
    session: session(),
  };
  const view = render(
    <WorkspaceSendPanel key="first" {...props} draftKey="first" />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: labels.draft }), {
    target: { value: "unsaved first" },
  });
  view.rerender(
    <WorkspaceSendPanel key="second" {...props} draftKey="second" />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: labels.send }));
  });
  expect(send.mock.calls[0]?.[0]).toEqual(new TextEncoder().encode("B"));
  expect(drafts.get("first")).toBe("unsaved first");
  act(() => vi.advanceTimersByTime(150));
  expect(observed.mock.calls.filter(([bytes]) => bytes !== null)).toEqual([
    [new TextEncoder().encode("B")],
  ]);
});
