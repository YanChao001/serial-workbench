import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  LONG_RECORD_PAGE_BYTES,
  type LongStreamRecord,
} from "./stream-long-record";
import {
  LongStreamRecordView,
  type LongRecordReading,
} from "./stream-long-record-view";
import { defaultHexFormat } from "./stream-hex";
import { labels } from "./test-fixtures";

afterEach(cleanup);

it("remembers the page after locating a byte and reopens a new location request", () => {
  const bytes = "A".repeat(2 * LONG_RECORD_PAGE_BYTES + 1);
  const record: LongStreamRecord = {
    key: "record",
    offset: 0n,
    end: BigInt(bytes.length),
    parts: [
      {
        itemIndex: 0,
        bytesBase64: btoa(bytes),
        offset: 0n,
        end: BigInt(bytes.length),
      },
    ],
  };
  const remembered = new Map<string, LongRecordReading>();
  const request = {};
  const show = (revealRequest: object) => (
    <LongStreamRecordView
      record={record}
      remembered={remembered}
      revealRequest={revealRequest}
      initialOffset={BigInt(LONG_RECORD_PAGE_BYTES)}
      labels={labels}
      mode="text"
      encoding="utf-8"
      hexFormat={defaultHexFormat}
    />
  );
  const first = render(show(request));
  expect(screen.getByRole("status")).toHaveTextContent("2/3");
  fireEvent.click(screen.getByRole("button", { name: labels.longRecordNext }));
  expect(screen.getByRole("status")).toHaveTextContent("3/3");
  first.unmount();
  const returned = render(show(request));
  expect(screen.getByRole("status")).toHaveTextContent("3/3");
  returned.rerender(show({}));
  expect(screen.getByRole("status")).toHaveTextContent("2/3");
});
