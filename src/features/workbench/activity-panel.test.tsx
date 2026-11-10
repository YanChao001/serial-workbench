import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { OperationSummary } from "@serial-workbench/contracts";
import { ActivityPanel } from "./activity-panel";
import { labels, operation } from "./test-fixtures";
afterEach(cleanup);
it("shows human activity summaries and keeps technical identities in explicit details", async () => {
  const source = operation("ai");
  const summary: OperationSummary = {
    operationId: source.operationId,
    executionHostId: source.executionHostId,
    actorId: "mcp-agent",
    actionId: source.actionId,
    target: source.target,
    executionMode: source.executionMode,
    state: "failed",
    revision: "2",
    acceptedAt: source.acceptedAt,
    revealTarget: source.revealTarget,
    progress: { completed: "12", total: "24", unit: "bytes" },
    errorCode: "PERMISSION_DENIED",
  };
  const locate = vi.fn();
  render(
    <ActivityPanel
      operations={[summary]}
      labels={labels}
      following={false}
      onFollowChange={vi.fn()}
      onLocate={locate}
    />,
  );
  expect(screen.getByText("Other client")).toBeInTheDocument();
  expect(screen.getByText(/12 B \/ 24 B/)).toBeInTheDocument();
  expect(
    screen.getByText(labels.operationText.failure("PERMISSION_DENIED")),
  ).toBeInTheDocument();
  expect(screen.queryByText("mcp-agent")).not.toBeInTheDocument();
  expect(screen.queryByText("PERMISSION_DENIED")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: labels.operationText.details }));
  expect(
    screen.getByRole("textbox", { name: labels.operationText.details }),
  ).toHaveProperty("value", expect.stringContaining('"actorId": "mcp-agent"'));
  await userEvent.setup().keyboard("{Escape}");
  fireEvent.click(screen.getByRole("button", { name: "Locate ai" }));
  expect(locate).toHaveBeenCalledWith(summary);
});
