import { Fragment, StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Toaster, toast } from "sonner";
import { WorkbenchNotice } from "./workbench-notice";

afterEach(() => {
  cleanup();
  toast.dismiss();
});

it.each([false, true])(
  "keeps an initial fault visible once and clears it when resolved (StrictMode: %s)",
  async (strict) => {
    const Mode = strict ? StrictMode : Fragment;
    const content = (present: boolean) => (
      <Mode>
        <Toaster />
        <WorkbenchNotice noticeKey="stream:SOURCE_ENDED">
          {present && <p role="alert">The stream stopped</p>}
        </WorkbenchNotice>
      </Mode>
    );
    const view = render(content(true));
    await screen.findByRole("alert");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("The stream stopped");
    view.rerender(content(true));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    view.rerender(content(false));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  },
);

it("updates a visible notice without reopening it when the same error changes busy state", async () => {
  const content = (busy: boolean) => (
    <>
      <Toaster />
      <WorkbenchNotice noticeKey="connection:FAILED">
        <p role="alert">Connection failed</p>
        <button disabled={busy}>{busy ? "Retrying" : "Retry"}</button>
      </WorkbenchNotice>
    </>
  );
  const view = render(content(false));
  expect(await screen.findByRole("button", { name: "Retry" })).toBeEnabled();
  view.rerender(content(true));
  expect(
    await screen.findByRole("button", { name: "Retrying" }),
  ).toBeDisabled();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("keeps a real failure visible through StrictMode cleanup and tool dismissal without replaying it on reopening", async () => {
  const content = (open: boolean) => (
    <StrictMode>
      <Toaster />
      {open && (
        <WorkbenchNotice
          noticeKey="real-event"
          eventKey="integration:failure-once"
        >
          <p role="alert">Recording request failed</p>
        </WorkbenchNotice>
      )}
    </StrictMode>
  );
  const view = render(content(true));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recording request failed",
  );
  view.rerender(content(false));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Recording request failed",
  );
  view.rerender(content(true));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});
