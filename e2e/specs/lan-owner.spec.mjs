import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { language, navigate, openDeepLink, ready } from "../helpers.mjs";
import {
  callerProfile,
  cli,
  connectAssistant,
  discovery,
  evidence,
  handoff,
  liveSession,
  ownerProfile,
  paramsFile,
  selected,
  sendDraft,
  sendParams,
  sibling,
  waitForEcho,
} from "./lan.mjs";
import { byText, button, click, dialogButton } from "./reference-plugin.mjs";
import { openVirtual } from "./workbench.mjs";

/* global describe, it */
describe("LAN on the host that owns the serial port", () => {
  it("shares one live session and takes control back from just one LAN client", async () => {
    await ready();
    await language("en");
    await navigate("/");
    await openVirtual();
    const session = await liveSession();
    const ownerInstance = await discovery(ownerProfile);
    const callerInstance = await discovery(callerProfile);
    assert.equal(session.hostId, ownerInstance.hostId);
    assert.notEqual(ownerInstance.pid, callerInstance.pid);
    assert.notEqual(ownerInstance.hostId, callerInstance.hostId);
    const { localPeer: caller } = await cli(callerProfile, "lan", "status");
    assert.equal(caller.hostId, callerInstance.hostId);

    await openDeepLink("/settings?focus=lanAccess");
    await click(button("Manage sharing"));
    await $("#lan-peer-info").setValue(JSON.stringify(caller));
    await click($("#lan-session-0"));
    await click(byText("*[@role='option']", "View and operate"));
    await click(dialogButton("Trust and pair"));
    await byText("*", "Paired with this computer").waitForDisplayed();
    await $("#lan-listen-address").setValue("127.0.0.1:0");
    await click(dialogButton("Allow LAN connections"));
    await dialogButton("Stop listening").waitForEnabled();
    const status = await cli(ownerProfile, "lan", "status");
    const owner = status.localPeer;
    const { address } = status.listener;
    assert.match(address, /^127\.0\.0\.1:[1-9]\d*$/);
    assert.deepEqual(status.peers, [
      { peer: caller, shares: [{ target: session, access: "operate" }] },
    ]);
    await browser.saveScreenshot(evidence("sharing.png"));
    await browser.keys(Key.Escape);
    const route = { hostId: owner.hostId, address };
    await cli(
      callerProfile,
      "lan",
      "--params-json",
      await paramsFile({ kind: "setShares", peer: owner, shares: [] }),
    );
    for (const clientId of [selected, sibling]) {
      const local = await connectAssistant(clientId);
      await local.stop();
      await cli(
        callerProfile,
        "authorize",
        "--params-json",
        await paramsFile({
          clientId,
          permissions: ["lan.connect"],
          targets: [
            { hostId: caller.hostId, kind: "swb:lan-peer", id: owner.hostId },
          ],
        }),
      );
    }
    await navigate("/");
    const assistants = [];
    try {
      const taken = await connectAssistant(selected, route);
      assistants.push(taken);
      const other = await connectAssistant(sibling, route);
      assistants.push(other);
      const send = (assistant, text) =>
        assistant.call("swb_session_x2E_tx", session, sendParams(text));
      const allowed = async (assistant) => {
        const checked = await assistant.call("swb_action_x2E_check", session, {
          actionId: "session.tx",
          params: sendParams("write permission probe"),
        });
        return checked.allowed;
      };
      assert.equal(await allowed(taken), true);
      const before = await send(taken, "LAN selected writer before takeover");
      await waitForEcho("LAN selected writer before takeover");
      await click($("button[aria-label='Activity']"));
      await click($("[role='combobox'][aria-label='AI client to follow']"));
      await click(byText("*[@role='option']", selected));
      await click(button("Take control of virtual:echo"));
      await byText(
        "*",
        "AI write access to this port was revoked.",
      ).waitForDisplayed();
      await browser.saveScreenshot(evidence("takeover.png"));
      assert.equal(await allowed(taken), false);
      await assert.rejects(
        send(taken, "LAN TX after write revocation"),
        (error) => error.code === -32601 || error.code === "PERMISSION_DENIED",
      );
      await taken.call("swb_session_x2E_get", session);
      assert.equal(await allowed(other), true);
      const after = await send(other, "LAN sibling after takeover");
      assert.notEqual(before.actorId, after.actorId);
      await waitForEcho("LAN sibling after takeover");
      await browser.keys(Key.Escape);
      await sendDraft().setValue("LAN owner after takeover");
      await click($("button[aria-label='Send']"));
      await waitForEcho("LAN owner after takeover");
      assert.deepEqual(await liveSession(), session);
      await writeFile(
        handoff,
        JSON.stringify({
          invitation: { ...owner, address },
          session,
          ownerInstance,
          callerInstance,
        }),
        { flag: "wx" },
      );
      await writeFile(
        evidence("receipt.json"),
        JSON.stringify(
          {
            ownerInstance,
            callerInstance,
            session,
            before: {
              operationId: before.operationId,
              actorId: before.actorId,
            },
            after: { operationId: after.operationId, actorId: after.actorId },
            selectedWriterRevoked: true,
            selectedReaderKeptAccess: true,
            localEchoAfterTakeover: true,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      for (const assistant of assistants) await assistant.stop();
    }
  });
});
