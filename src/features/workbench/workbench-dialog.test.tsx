import { useRef, useState, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UnsavedWorkContext } from "@/providers/unsaved-work-context";
import { OperationDetails } from "./operation-details";
import { operation } from "./test-fixtures";
import { WorkbenchDialog } from "./workbench-dialog";

afterEach(cleanup);

function Example({
  children,
  scopeKey = "current",
  closed = () => {},
}: {
  children: ReactNode;
  scopeKey?: string;
  closed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        Open tool
      </button>
      <WorkbenchDialog
        open={open}
        title="Tool"
        scopeKey={scopeKey}
        closeLabel="Close"
        returnFocus={trigger}
        onRequestClose={() => {
          closed();
          setOpen(false);
        }}
      >
        {children}
      </WorkbenchDialog>
    </>
  );
}

it("opens a read-only tool without an automatic tooltip and closes with one Escape", async () => {
  const user = userEvent.setup();
  const closed = vi.fn();
  render(
    <Example closed={closed}>
      <p>Recorded progress</p>
      <OperationDetails operation={operation()} label="Technical details" />
    </Example>,
  );
  const trigger = screen.getByRole("button", { name: "Open tool" });
  await user.click(trigger);
  const body = screen
    .getByRole("dialog", { name: "Tool" })
    .querySelector(".workbench-dialog-body");
  expect(body).toHaveAttribute("tabindex", "0");
  expect(body).toHaveFocus();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(closed).toHaveBeenCalledOnce();
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("makes a purely read-only scroll body a keyboard stop without adding a competing named region", async () => {
  const user = userEvent.setup();
  render(
    <Example>
      <section aria-label="Runtime status">
        <p>Read-only runtime values</p>
      </section>
    </Example>,
  );
  const trigger = screen.getByRole("button", { name: "Open tool" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Tool" });
  const body = dialog.querySelector(".workbench-dialog-body");
  expect(body).toHaveAttribute("tabindex", "0");
  expect(body).toHaveFocus();
  expect(
    screen.getAllByRole("region", { name: "Runtime status" }),
  ).toHaveLength(1);
  await user.tab();
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(body).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("keeps auxiliary details reachable by Tab and shows their tooltip on intentional focus", async () => {
  const user = userEvent.setup();
  render(
    <Example>
      <OperationDetails operation={operation()} label="Technical details" />
    </Example>,
  );
  await user.click(screen.getByRole("button", { name: "Open tool" }));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.tab();
  const details = screen.getByRole("button", { name: "Technical details" });
  expect(details).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Technical details",
  );
});

it.each(["input", "select"])(
  "focuses the first available primary %s and ignores hidden or inert ancestors",
  async (kind) => {
    const user = userEvent.setup();
    render(
      <Example>
        <style>{".test-hidden-section { display: none; }"}</style>
        <OperationDetails operation={operation()} label="Technical details" />
        <div className="test-hidden-section">
          <Input aria-label="CSS hidden" />
        </div>
        <div style={{ visibility: "hidden" }}>
          <Input aria-label="Invisible" />
        </div>
        <div hidden>
          <Input aria-label="Hidden" />
        </div>
        <div inert>
          <Input aria-label="Inert" />
        </div>
        <fieldset disabled>
          <Input aria-label="Disabled field" />
        </fieldset>
        {kind === "input" ? (
          <Input aria-label="Main control" defaultValue="Current value" />
        ) : (
          <Select defaultValue="current">
            <SelectTrigger aria-label="Main control">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">Current workspace</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Example>,
    );
    await user.click(screen.getByRole("button", { name: "Open tool" }));
    const control = screen.getByRole(
      kind === "input" ? "textbox" : "combobox",
      {
        name: "Main control",
      },
    );
    expect(control).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    if (control instanceof HTMLInputElement) {
      expect(control.selectionStart).toBe(0);
      expect(control.selectionEnd).toBe(control.value.length);
    }
  },
);

it("keeps a read-only tool open for leave negotiation and rejects a late result after a scope change", async () => {
  const user = userEvent.setup();
  let allow!: (value: boolean) => void;
  const requestLeave = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        allow = resolve;
      }),
  );
  const registry = {
    requestLeave,
    register: vi.fn(),
    unregister: vi.fn(),
    releaseScope: vi.fn(),
  };
  const closed = vi.fn();
  const content = (scopeKey: string) => (
    <UnsavedWorkContext value={registry}>
      <Example scopeKey={scopeKey} closed={closed}>
        <OperationDetails operation={operation()} label="Technical details" />
      </Example>
    </UnsavedWorkContext>
  );
  const view = render(content("original"));
  await user.click(screen.getByRole("button", { name: "Open tool" }));
  await user.keyboard("{Escape}");
  expect(requestLeave).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Tool" })).toBeInTheDocument();
  view.rerender(content("replacement"));
  await act(async () => allow(true));
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Tool" })).toBeInTheDocument();
});
