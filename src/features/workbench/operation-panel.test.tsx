import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OperationPanel } from "./operation-panel";
import { labels, operation } from "./test-fixtures";
afterEach(cleanup);
it("retains accepted and unknown file bytes after cancellation without claiming a device acknowledgement", () => {
  render(
    <OperationPanel
      labels={labels}
      operations={[
        {
          ...operation(),
          actionId: "transfer.file",
          state: "cancelled",
          result: {
            kind: "file_transfer",
            value: {
              requested: "100",
              accepted: "40",
              unknown: "3",
              peerAcknowledged: false,
              receiptsRef: {
                hostId: "host",
                kind: "file",
                id: "receipts",
                revision: "1",
              },
            },
          },
        },
      ]}
    />,
  );
  expect(screen.getByLabelText(labels.requestedBytes)).toHaveTextContent("100");
  expect(screen.getByLabelText(labels.acceptedBytes)).toHaveTextContent("40");
  expect(screen.getByLabelText(labels.unknownBytes)).toHaveTextContent("3");
  expect(screen.getByText(labels.peerUnconfirmed)).toBeInTheDocument();
});
