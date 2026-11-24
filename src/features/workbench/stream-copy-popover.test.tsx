import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { saveTextExport } from "@/lib/tauri";
import { StreamCopyPopover } from "./stream-copy-popover";
import { labels } from "./test-fixtures";
import type { StreamCopySample } from "./stream-copy";
import type { StreamHexSelection } from "./stream-hex-selection";

vi.mock("@/lib/tauri", () => ({ saveTextExport: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const selection: StreamHexSelection = {
  start: { source: "rx-1", offset: 4n, ascii: false },
  end: { source: "rx-1", offset: 5n, ascii: false },
  backwards: false,
};
const sample: StreamCopySample = {
  offset: 4n,
  direction: "RX",
  bytes: Uint8Array.of(65),
  parts: [],
};

it("does not save a selection that changed after preview, or report a cancelled save as completed", async () => {
  const user = userEvent.setup();
  const readSample = vi.fn((): StreamCopySample | undefined => sample);
  render(
    <StreamCopyPopover
      readSelection={() => selection}
      readSample={readSample}
      receiveEncoding="utf-8"
      sendEncoding="utf-8"
      labels={labels}
    />,
  );
  await user.click(screen.getByRole("button", { name: labels.copySelection }));
  await user.click(screen.getByRole("combobox", { name: labels.copyFormat }));
  await user.click(screen.getByRole("option", { name: "HTML" }));
  const save = screen.getByRole("button", { name: labels.selectionSave });
  readSample.mockReturnValueOnce(undefined);
  await user.click(save);
  expect(screen.getByRole("status")).toHaveTextContent(
    labels.selectionUnavailable,
  );
  expect(saveTextExport).not.toHaveBeenCalled();

  vi.mocked(saveTextExport).mockResolvedValueOnce(null);
  await user.click(save);
  await waitFor(() => expect(save).toBeEnabled());
  expect(saveTextExport).toHaveBeenCalledOnce();
  expect(screen.queryByText(labels.selectionSaved)).not.toBeInTheDocument();
});
