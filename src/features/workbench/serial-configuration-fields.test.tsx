import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaults,
  type SerialConfiguration,
} from "@serial-workbench/contracts";
import { SerialConfigurationFields } from "./serial-configuration-fields";
import { BAUD_PRESETS } from "./serial-configuration";
import { controlLabels } from "./session-controls.test-fixtures";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

afterEach(cleanup);

function Example({
  changed = (_value: SerialConfiguration) => {},
  disabled = false,
}: {
  changed?: (value: SerialConfiguration) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaults.serialConfiguration);
  return (
    <fieldset disabled={disabled}>
      <SerialConfigurationFields
        id="serial"
        value={value}
        labels={controlLabels}
        onChange={(next) => {
          setValue(next);
          changed(next);
        }}
      />
      <button type="button">After fields</button>
    </fieldset>
  );
}

it("opens every common baud preset independently of the current value and accepts custom values", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<Example changed={changed} />);
  const input = screen.getByLabelText("Baud rate");
  expect(input).toHaveValue("9600");
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  const choices = await screen.findByRole("listbox", { name: "Baud presets" });
  expect(within(choices).getAllByRole("option")).toHaveLength(
    BAUD_PRESETS.length,
  );
  expect(within(choices).getByRole("option", { name: "115200" })).toBeVisible();
  await user.keyboard("{Escape}");
  await user.clear(input);
  await user.type(input, "31250");
  expect(input).toHaveValue("31250");
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ baudRate: "31250" }),
  );
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  expect(screen.getAllByRole("option")).toHaveLength(BAUD_PRESETS.length);
  await user.keyboard("{Escape}");
  expect(input).toHaveValue("31250");
  expect(input).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  await user.click(screen.getByRole("option", { name: "115200" }));
  expect(input).toHaveValue("115200");
});

it("selects baud presets by keyboard while IME confirmation does not choose an option", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<Example changed={changed} />);
  const input = screen.getByLabelText("Baud rate");
  await user.click(input);
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox", { name: "Baud presets" });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeVisible();
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(screen.getByRole("listbox")).toBeVisible();
  fireEvent.compositionEnd(input);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(input).toHaveValue("19200");
  await waitFor(() =>
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
  );
  expect(input).toHaveFocus();
  await user.keyboard("{ArrowDown}{Tab}");
  await waitFor(() =>
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("combobox", { name: "Data bits" })).toHaveFocus();
});

it.each(["Enter", "Escape"])(
  "ignores the IME keyCode 229 %s boundary after compositionEnd",
  async (key) => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Connection options</DialogTitle>
          <Example changed={changed} />
        </DialogContent>
      </Dialog>,
    );
    const input = screen.getByRole("combobox", { name: "Baud rate" });
    await user.click(screen.getByRole("button", { name: "Baud presets" }));
    await screen.findByRole("listbox", { name: "Baud presets" });
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: "115200" })).toHaveAttribute(
      "id",
      input.getAttribute("aria-activedescendant"),
    );
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key, keyCode: 229, isComposing: false });
    expect(changed).not.toHaveBeenCalled();
    expect(input).toHaveValue("9600");
    expect(screen.getByRole("listbox", { name: "Baud presets" })).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Connection options" }),
    ).toBeVisible();
    await user.keyboard(`{${key}}`);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue(key === "Enter" ? "115200" : "9600");
    expect(input).toHaveFocus();
    expect(
      screen.getByRole("dialog", { name: "Connection options" }),
    ).toBeVisible();
  },
);

it("uses the shared options popup for enumerated parameters and retains typed values", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<Example changed={changed} />);
  await user.click(screen.getByRole("combobox", { name: "Data bits" }));
  const choices = await screen.findByRole("listbox");
  await user.click(within(choices).getByRole("option", { name: "7" }));
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ dataBits: "7" }),
  );
  expect(screen.getByRole("combobox", { name: "Data bits" })).toHaveTextContent(
    "7",
  );
});

it("closes the editable choices and blocks selection when its fieldset becomes disabled", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const view = render(<Example changed={changed} />);
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  await screen.findByRole("listbox");
  await act(async () => view.rerender(<Example changed={changed} disabled />));
  await waitFor(() =>
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("Baud rate")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Baud presets" })).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
  await act(async () => view.rerender(<Example changed={changed} />));
  expect(screen.getByRole("button", { name: "Baud presets" })).toBeEnabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  expect(screen.getByRole("listbox")).toBeVisible();
});

it("preserves invalid manual drafts without replacing them with a preset", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const input = screen.getByLabelText("Baud rate");
  await user.clear(input);
  await user.type(input, "0");
  expect(input).toHaveValue("0");
  expect(input).toHaveAttribute("aria-invalid", "true");
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  expect(screen.getAllByRole("option")).toHaveLength(BAUD_PRESETS.length);
  await user.keyboard("{Escape}");
  expect(input).toHaveValue("0");
});

it("closes the baud options on Escape before dismissing its containing tool dialog", async () => {
  const user = userEvent.setup();
  render(
    <Dialog defaultOpen>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Connection options</DialogTitle>
        <Example />
      </DialogContent>
    </Dialog>,
  );
  const input = screen.getByLabelText("Baud rate");
  await user.click(screen.getByRole("button", { name: "Baud presets" }));
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Connection options" }),
  ).toBeVisible();
  expect(input).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
