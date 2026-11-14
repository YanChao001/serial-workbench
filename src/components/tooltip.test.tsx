import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

afterEach(cleanup);

function SettingsExample() {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={() => setOpen(true)}>Workspace settings</button>
        </TooltipTrigger>
        <TooltipContent>Workspace: Example</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Workspace</DialogTitle>
          <input aria-label="Workspace name" />
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

it.each(["mouse", "Escape"])(
  "restores focus after %s closes settings without showing its tooltip",
  async (close) => {
    const user = userEvent.setup();
    render(<SettingsExample />);
    const trigger = screen.getByRole("button", { name: "Workspace settings" });
    await user.click(trigger);
    if (close === "mouse")
      await user.click(screen.getByRole("button", { name: "Close" }));
    else {
      await user.click(screen.getByRole("textbox", { name: "Workspace name" }));
      await user.keyboard("{Escape}");
    }
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  },
);

it("shows keyboard navigation hints but keeps restored focus quiet until navigating again", async () => {
  const user = userEvent.setup();
  render(<SettingsExample />);
  const trigger = screen.getByRole("button", { name: "Workspace settings" });
  await user.tab();
  expect(trigger).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.tab();
  await user.tab({ shift: true });
  expect(trigger).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toBeInTheDocument();
});
