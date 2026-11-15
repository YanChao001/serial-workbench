import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Textarea } from "./textarea";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function UncontrolledEditor({ initial = "seed" }: { initial?: string }) {
  const [edits, setEdits] = useState(0);
  return (
    <form aria-label="Draft form">
      <Textarea
        aria-label="Draft"
        defaultValue={initial}
        onChange={() => setEdits((value) => value + 1)}
      />
      <output aria-label="Edits">{edits}</output>
    </form>
  );
}

it("native edits update React state without rewriting an unchanged textarea default", () => {
  const writes = vi.spyOn(HTMLTextAreaElement.prototype, "defaultValue", "set");
  render(<UncontrolledEditor />);
  const input = screen.getByRole("textbox", { name: "Draft" });
  writes.mockClear();
  fireEvent.input(input, { target: { value: "seed one" } });
  fireEvent.input(input, { target: { value: "seed one two" } });
  expect(input).toHaveValue("seed one two");
  expect(screen.getByLabelText("Edits")).toHaveTextContent("2");
  expect(writes).not.toHaveBeenCalled();
});

it("external default changes preserve the edited value and apply on form reset", () => {
  const { rerender } = render(<UncontrolledEditor initial="first" />);
  const input = screen.getByRole("textbox", { name: "Draft" });
  fireEvent.input(input, { target: { value: "user edit" } });
  rerender(<UncontrolledEditor initial="second" />);
  expect(input).toHaveValue("user edit");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing textarea");
  expect(input.defaultValue).toBe("second");
  const form = screen.getByRole("form", { name: "Draft form" });
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing form");
  form.reset();
  expect(input).toHaveValue("second");
});

it("controlled text follows native edits and explicit external replacement", () => {
  function Controlled({ replacement }: { replacement?: string }) {
    const [value, setValue] = useState("first");
    return (
      <Textarea
        aria-label="Controlled draft"
        value={replacement ?? value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
    );
  }
  const { rerender } = render(<Controlled />);
  const input = screen.getByRole("textbox", { name: "Controlled draft" });
  fireEvent.input(input, { target: { value: "user edit" } });
  expect(input).toHaveValue("user edit");
  rerender(<Controlled replacement="external" />);
  expect(input).toHaveValue("external");
});
