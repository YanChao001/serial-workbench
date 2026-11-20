import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import { queryArgs } from "../cli-query.mjs";
import { language, navigate, ready } from "../helpers.mjs";
import { nativeValue } from "../settings.mjs";
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
  sendDraft,
  sendParams,
  sibling,
  waitForEcho,
} from "./lan.mjs";
import { byText, click, dialogButton } from "./reference-plugin.mjs";
import { openVirtual } from "./workbench.mjs";

async function connectionDialog() {
  await click($("button[aria-label='Workspace menu']"));
  await browser.keys(Key.ArrowDown);
  await click(byText("*[@role='menuitem']", "LAN connection"));
  return $("[role='dialog']");
}

/* global describe, it */
describe("LAN on the desktop using the shared serial port", () => {
  it("opens the owner’s session, exchanges data, follows a named MCP client and returns to the local Host", async () => {
    const { invitation, session, ownerInstance, callerInstance } = JSON.parse(
      await readFile(handoff, "utf8"),
    );
    assert.deepEqual(await discovery(ownerProfile), ownerInstance);
    assert.deepEqual(await discovery(callerProfile), callerInstance);
    await ready();
    await language("en");
    await navigate("/");
    const local = await nativeValue("host_attachment");
    assert.equal(local.attachment.hostId, callerInstance.hostId);

    const connection = await connectionDialog();
    await connection
      .$("input[type='password']")
      .setValue(JSON.stringify(invitation));
    const address = connection.$("input[placeholder='192.168.1.8:8022']");
    await address.waitForDisplayed();
    assert.equal(await address.getValue(), invitation.address);
    await click(dialogButton("Connect"));
    await connection.waitForExist({ reverse: true });
    await openVirtual();
    const remote = await nativeValue("host_attachment");
    assert.equal(remote.attachment.hostId, ownerInstance.hostId);
    assert.equal(remote.attachment.instanceEpoch, ownerInstance.instanceEpoch);
    assert.notEqual(remote.generation, local.generation);
    assert.deepEqual(await liveSession(), session);

    await sendDraft().setValue("LAN from the caller desktop");
    await click($("button[aria-label='Send']"));
    await waitForEcho("LAN from the caller desktop");
    await browser.saveScreenshot(evidence("shared-workbench.png"));
    await sendDraft().setValue("");

    const readOwnerSession = queryArgs(
      "session.get",
      await paramsFile(session),
      await paramsFile({}),
    );
    const assistant = await connectAssistant(sibling, invitation);
    let configured;
    const configuredAt = "19200";
    try {
      await assistant.call(
        "swb_session_x2E_tx",
        session,
        sendParams("LAN from the named assistant"),
      );
      await waitForEcho("LAN from the named assistant");
      const sessionBefore = await assistant.call(
        "swb_session_x2E_get",
        session,
      );
      await click($("button[aria-label='Activity']"));
      await click($("[role='combobox'][aria-label='AI client to follow']"));
      await click(byText("*[@role='option']", sibling));
      const activity = $("[role='dialog']");
      await click(activity.$("[data-slot='dialog-close']"));
      await activity.waitForExist({ reverse: true });

      const draft = sendDraft();
      await browser.execute(
        (id) => document.getElementById(id).focus(),
        await draft.getAttribute("id"),
      );
      configured = await assistant.call(
        "swb_session_x2E_configure",
        session,
        {
          requested: { ...sessionBefore.configuration, baudRate: configuredAt },
        },
        { expectedRevision: sessionBefore.revision },
      );
      const parameters = byText(
        "*",
        "Connection parameters",
        "//*[@role='dialog']",
      );
      await browser.waitUntil(
        async () => {
          const reply = await cli(ownerProfile, ...readOwnerSession);
          return reply.value.configuration.baudRate === configuredAt;
        },
        { timeoutMsg: "The remote Host did not apply the requested baud rate" },
      );
      assert.equal(await draft.isFocused(), true);
      assert.equal(await parameters.isDisplayed(), false);
      await browser.execute(() => {
        document.querySelector("button[aria-label='Activity']").focus();
      });
      await parameters.waitForDisplayed();
      const callerSession = await assistant.call(
        "swb_session_x2E_get",
        session,
      );
      assert.equal(callerSession.configuration.baudRate, configuredAt);
      await browser.saveScreenshot(
        evidence("follow-connection-parameters.png"),
      );
      const configuration = $("[role='dialog']");
      await click(configuration.$("[data-slot='dialog-close']"));
      await configuration.waitForExist({ reverse: true });
    } finally {
      await assistant.stop();
    }

    const retainedDraft = "Draft for the shared serial port";
    await sendDraft().setValue(retainedDraft);
    const returning = await connectionDialog();
    await click(dialogButton("Return to this computer"));
    await click(dialogButton("Save and continue"));
    await returning.waitForExist({ reverse: true });
    const returned = await nativeValue("host_attachment");
    assert.equal(returned.attachment.hostId, callerInstance.hostId);
    assert.equal(
      returned.attachment.instanceEpoch,
      callerInstance.instanceEpoch,
    );
    const localState = await nativeValue("client_state_read");
    assert.ok(Object.values(localState.state.drafts).includes(retainedDraft));
    assert.deepEqual(await discovery(ownerProfile), ownerInstance);
    const ownerSession = await cli(ownerProfile, ...readOwnerSession);
    assert.equal(ownerSession.value.sessionId, session.sessionId);
    assert.equal(ownerSession.value.sessionEpoch, session.sessionEpoch);
    assert.equal(ownerSession.value.state, "open");
    await writeFile(
      evidence("receipt.json"),
      JSON.stringify(
        {
          ownerInstance,
          callerInstance,
          session,
          ownerGeneration: remote.generation,
          callerGeneration: returned.generation,
          echoedFromDesktop: true,
          followedAssistantOperation: configured.operationId,
          baudRate: configuredAt,
          followedAfterLeavingDraft: true,
          draftSavedOnCaller: true,
          ownerSessionStayedOpen: true,
        },
        null,
        2,
      ) + "\n",
    );
  });
});
