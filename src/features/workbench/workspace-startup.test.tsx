import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import {
  defaults,
  type Operation,
  type Target,
  type WorkspaceDocumentResult,
  type WorkspaceScriptReference,
} from "@serial-workbench/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { en } from "@/i18n/en";
import { createTranslator } from "@/i18n/translate";
import { I18nContext } from "@/providers/i18n-context";
import type { HostInvocation } from "@/providers/host-context";
import { Rfc2217ConnectionParameters } from "./rfc2217-connection-parameters";
import { operation, session } from "./test-fixtures";
import { WorkspaceStartup } from "./workspace-startup";

afterEach(cleanup);

const language = { language: "en", t: createTranslator(en) } as const;

it("stops awaiting an old session when a script reply arrives after reconnect", async () => {
  const user = userEvent.setup();
  const action: WorkspaceScriptReference = {
    actionId: "example.startup.status",
    packageId: "example.startup",
    version: "1.0.0",
    archiveSha256: "5".repeat(64),
  };
  const hostTarget: Target = { hostId: "host", kind: "host", id: "host" };
  const base: WorkspaceDocumentResult = {
    scope: {
      scopeId: "workspace.bench",
      target: { hostId: "host", kind: "workspace", id: "bench" },
    },
    document: {
      revision: "1",
      value: {
        ...defaults.workspace,
        views: [
          {
            id: "console",
            bindingId: "saved-binding",
            name: "Console",
            color: "#2266AA",
            icon: "terminal",
            pinned: false,
            receiveMode: "text",
            sendMode: "text",
          },
        ],
      },
    },
  };
  let resolvePrior!: (value: Operation) => void;
  const prior = new Promise<Operation>((resolve) => {
    resolvePrior = resolve;
  });
  const invoke = vi
    .fn<(input: HostInvocation, signal?: AbortSignal) => Promise<Operation>>()
    .mockImplementationOnce(() => prior)
    .mockResolvedValueOnce(operation("new-session-accepted"));
  const host: ComponentProps<typeof WorkspaceStartup>["host"] = {
    state: {
      status: "ready",
      devices: [],
      devicesStale: false,
      operations: [],
    },
    connection: { hostTarget, attachment: { hostId: "host" } },
    readWorkspaceStartupPlan: async () => ({
      scope: base.scope,
      workspaceRevision: "1",
      scripts: [
        { reference: action, status: "matched", targetKinds: ["session"] },
      ],
    }),
    checkAction: async ({ actionId, target }) => ({
      actionId,
      target,
      allowed: true,
    }),
    invoke,
  };
  const renderForEpoch = (epoch: string) => (
    <I18nContext.Provider value={language}>
      <WorkspaceStartup
        base={base}
        host={host}
        connections={{
          busy: false,
          connect: vi.fn(),
          sessions: new Map([
            ["console", { ...session("same-session"), sessionEpoch: epoch }],
          ]),
        }}
      />
    </I18nContext.Provider>
  );
  const view = render(renderForEpoch("1"));
  await user.click(screen.getByRole("button", { name: "Start workspace" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Select script example.startup.status",
    }),
  );
  async function chooseTarget() {
    await user.click(screen.getByRole("combobox", { name: "Run target" }));
    await user.click(await screen.findByRole("option", { name: "Console" }));
  }
  await chooseTarget();
  await user.click(screen.getByRole("button", { name: "Run script" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  const oldSignal = invoke.mock.calls[0]?.[1];
  expect(oldSignal?.aborted).toBe(false);
  view.rerender(renderForEpoch("2"));
  expect(oldSignal?.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Run script" })).toBeDisabled();
  await act(async () => resolvePrior(operation("old-session-accepted")));
  expect(screen.queryByText(/old-session-accepted/)).not.toBeInTheDocument();
  await chooseTarget();
  await user.click(screen.getByRole("button", { name: "Run script" }));
  expect(await screen.findByText(/new-session-accepted/)).toBeVisible();
  expect(invoke.mock.calls[1]?.[0].target.sessionEpoch).toBe("2");
});

it("starts RFC 2217 with saved line settings after entering only the endpoint", () => {
  const onSubmit = vi.fn();
  const line = {
    baudRate: "9600",
    dataBits: "7",
    parity: "even",
    stopBits: "two",
    flowControl: "xonXoff",
  } as const;
  render(
    <I18nContext.Provider value={language}>
      <Dialog open>
        <DialogContent>
          <DialogTitle>RFC 2217</DialogTitle>
          <DialogDescription>Saved serial settings</DialogDescription>
          <Rfc2217ConnectionParameters
            opening={false}
            initialConfiguration={line}
            onSubmit={onSubmit}
          />
        </DialogContent>
      </Dialog>
    </I18nContext.Provider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Remote address" }), {
    target: { value: "127.0.0.1" },
  });
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), {
    target: { value: "2217" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
    {
      host: "127.0.0.1",
      port: 2217,
      baudRate: 9600,
      dataBits: 7,
      parity: "even",
      stopBits: "2",
      flowControl: "software",
    },
    line,
  );
});
