import { StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { StreamItem } from "@serial-workbench/contracts";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import { StreamView } from "./stream-view";
import { labels, txItem } from "./test-fixtures";

vi.mock("sonner", () => ({ toast: { custom: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.clearAllMocks();
});

function sourceGap(
  seq: number,
  sessionId: string,
  sessionEpoch = "1",
): StreamItem {
  const base = txItem("tx_intent");
  if (base.kind !== "source") throw new Error("Expected source event");
  return {
    kind: "source",
    event: {
      ...base.event,
      sessionId,
      sessionEpoch,
      eventSeq: String(seq),
      kind: "gap",
      payload: { reason: "backend_loss", knownExtent: false },
    },
  };
}

function readerGap(
  seq: number,
  sessionId: string,
  sessionEpoch = "1",
): StreamItem {
  return {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId,
      sessionEpoch,
      reason: "reader_overflow",
      missingEventRange: { start: String(seq), end: String(seq + 1) },
    },
  };
}

it("counts a second real gap while one continuous warning keeps its original five-second lifetime", () => {
  const first = sourceGap(1, "gap-counter");
  const second = sourceGap(2, "gap-counter");
  const content = (items: readonly StreamItem[]) => (
    <StrictMode>
      <StreamView items={items} labels={labels} />
    </StrictMode>
  );
  const view = render(content([first]));
  expect(getUserLog()[0]?.count).toBe(1);
  view.rerender(content([first, second]));
  expect(getUserLog()[0]?.count).toBe(2);
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(vi.mocked(toast.custom).mock.calls[0]?.[1]).toMatchObject({
    duration: 5000,
    closeButton: true,
  });
  view.rerender(content([{ ...first }, { ...second }]));
  view.unmount();
  render(content([first, second]));
  expect(getUserLog()[0]?.count).toBe(2);
  expect(toast.custom).toHaveBeenCalledOnce();
  expect(JSON.stringify(getUserLog())).not.toContain("gap-counter");
});

it.each([sourceGap, readerGap])(
  "counts every independent gap in a batch once even when the list repeats or reorders old entries",
  (makeGap) => {
    const source = makeGap === sourceGap ? "source-batch" : "reader-batch";
    const first = makeGap(1, source),
      second = makeGap(2, source),
      third = makeGap(3, source);
    const view = render(
      <StreamView items={[second, first, second, third]} labels={labels} />,
    );
    expect(getUserLog()[0]?.count).toBe(3);
    expect(toast.custom).toHaveBeenCalledOnce();
    view.rerender(
      <StreamView items={[first, second, third]} labels={labels} />,
    );
    expect(getUserLog()[0]?.count).toBe(3);
    expect(toast.custom).toHaveBeenCalledOnce();
  },
);

it("does not recount a retained list larger than the event ledger across rerenders and tool reopening", () => {
  const gaps = Array.from({ length: 600 }, (_value, index) =>
    readerGap(index, "long-gap-history"),
  );
  const view = render(<StreamView items={gaps} labels={labels} />);
  expect(getUserLog()[0]?.count).toBe(600);
  view.rerender(<StreamView items={[...gaps]} labels={labels} />);
  view.unmount();
  render(<StreamView items={gaps} labels={labels} />);
  expect(getUserLog()[0]?.count).toBe(600);
  expect(toast.custom).toHaveBeenCalledOnce();
}, 15000);

it("isolates source and reader identities and starts a new warning episode only after clearing or a new source epoch", () => {
  const first = sourceGap(1, "gap-episodes");
  const reader = readerGap(1, "gap-episodes");
  const view = render(<StreamView items={[first, reader]} labels={labels} />);
  expect(getUserLog()[0]?.count).toBe(2);
  expect(toast.custom).toHaveBeenCalledOnce();
  view.rerender(<StreamView items={[]} labels={labels} />);
  view.rerender(
    <StreamView
      items={[first, reader, sourceGap(2, "gap-episodes")]}
      labels={labels}
    />,
  );
  expect(getUserLog()[0]?.count).toBe(3);
  expect(toast.custom).toHaveBeenCalledTimes(2);
  const changedEpoch = sourceGap(1, "gap-episodes", "2");
  view.rerender(
    <StreamView items={[first, reader, changedEpoch]} labels={labels} />,
  );
  expect(getUserLog()[0]?.count).toBe(4);
  expect(toast.custom).toHaveBeenCalledTimes(3);
  if (changedEpoch.kind !== "source") throw new Error("Expected source event");
  const changedHost: StreamItem = {
    kind: "source",
    event: { ...changedEpoch.event, hostId: "other-host" },
  };
  view.rerender(
    <StreamView
      items={[first, reader, changedEpoch, changedHost]}
      labels={labels}
    />,
  );
  expect(getUserLog()[0]?.count).toBe(5);
  expect(toast.custom).toHaveBeenCalledTimes(4);
  view.rerender(
    <StreamView
      items={[first, reader, changedEpoch, changedHost]}
      labels={labels}
    />,
  );
  expect(getUserLog()[0]?.count).toBe(5);
  expect(toast.custom).toHaveBeenCalledTimes(4);
});
