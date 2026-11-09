import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OperationSummary } from "@serial-workbench/contracts";
import { ActivityPanel } from "./activity-panel";
import { labels, operation } from "./test-fixtures";
afterEach(cleanup);
it("renders safe activity summaries without inventing an operation body", () => {
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
  expect(screen.getByText("mcp-agent")).toBeInTheDocument();
  expect(screen.getByText(/12 \/ 24 bytes/)).toBeInTheDocument();
  expect(screen.getByText("PERMISSION_DENIED")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Locate ai" }));
  expect(locate).toHaveBeenCalledWith(summary);
});
