import assert from "node:assert/strict";
import { expect } from "@playwright/test";

const ruleAction = "swb.builtin.automation.rule";
const sequenceAction = "swb.builtin.automation.sequence";

export async function checkRuleCommand({
  page,
  session,
  readRaw,
  getOperation,
  readResult,
  readWorkspace,
}) {
  const before = await readRaw("rule-before");
  const title = /^(Rule triggers|规则触发)$/;
  const dialog = page.getByRole("dialog", { name: title });
  const open = async () => {
    await page
      .getByRole("button", { name: /^(Workspace menu|工作区菜单)$/ })
      .press("ArrowDown");
    await page.getByRole("menuitem", { name: title }).click();
  };
  const close = () =>
    dialog.getByRole("button", { name: /^(Close view|关闭视图)$/ }).click();
  const status = dialog.getByRole("status");
  const unsaved = page.getByRole("dialog", {
    name: /^(Save unfinished work|保存未完成的工作)$/,
  });
  async function armAndTrigger(marker, effect) {
    await open();
    await dialog
      .getByRole("textbox", {
        name: /^(Rule definition \(JSON\)|规则定义（JSON）)$/,
      })
      .fill(
        JSON.stringify({
          version: 1,
          observationMs: 15_000,
          condition: { kind: "regex", pattern: "^" + marker + "$" },
          effect,
        }),
      );
    await dialog.getByRole("button", { name: /^(Arm rule|武装规则)$/ }).click();
    await expect(status).toContainText(
      /Rule armed and waiting for a match\.|规则已武装，等待匹配。/,
    );
    const operationId = (await status.innerText()).match(
      /(?:Task|任务) ([0-9a-f-]{36})/,
    )?.[1];
    assert.ok(operationId, "Rule panel must show the parent operation ID");
    await close();
    await unsaved
      .getByRole("button", { name: /^(Discard and continue|放弃并继续)$/ })
      .click();
    await expect(dialog).toBeHidden();
    await page
      .getByRole("textbox", { name: /Send draft|发送草稿/ })
      .fill("\n" + marker + "\n");
    await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
    await open();
    return operationId;
  }

  const sequenceBytes = "52 55 4C 45 3A 41 43 4B";
  const parentId = await armAndTrigger("RULE:BENCH", {
    kind: "action",
    actionId: sequenceAction,
    params: {
      startEventSeq: before.nextEventSeq,
      definition: JSON.stringify({
        version: 1,
        steps: [
          {
            kind: "send",
            hex: sequenceBytes,
            expect: { hex: sequenceBytes, timeoutMs: 1_000 },
          },
        ],
      }),
    },
  });
  await expect(status).toContainText(
    /The triggered action completed\.|触发动作已完成。/,
  );
  const effectId = (await status.innerText()).match(
    /(?:Effect receipt|触发动作回执) ([0-9a-f-]{36})/,
  )?.[1];
  assert.ok(effectId, "Rule panel must show the effect operation ID");
  await close();

  const parent = await getOperation(parentId);
  const effect = await getOperation(effectId);
  assert.equal(parent.actionId, ruleAction);
  assert.equal(parent.state, "succeeded");
  assert.equal(parent.childHighWatermark, "1");
  assert.equal(effect.actionId, sequenceAction);
  assert.equal(effect.state, "succeeded");
  for (const op of [parent, effect]) {
    assert.deepEqual(op.target, session);
    assert.equal(op.rootOperationId, parentId);
  }
  const rule = await readResult("rule-result", parent.result.value.resultRef);
  const sequence = await readResult(
    "rule-sequence",
    effect.result.value.resultRef,
  );
  assert.equal(rule.outcome, "action_completed");
  assert.equal(rule.operationId, effectId);
  assert.equal(sequence.outcome, "completed");
  assert.equal(sequence.completedSteps, 1);
  assert.equal(sequence.attempts.length, 1);
  assert.equal(sequence.attempts[0].outcome, "matched");

  const after = await readRaw("rule-after", before.nextEventSeq);
  const tx = after.events.filter(({ kind }) => kind === "tx");
  const rx = after.events.filter(({ kind }) => kind === "rx");
  const text = (events) =>
    Buffer.concat(
      events.map((event) => Buffer.from(event.payload.bytesBase64, "base64")),
    ).toString("utf8");
  assert.equal(text(tx), "\nRULE:BENCH\nRULE:ACK");
  assert.equal(text(rx), "\nRULE:BENCH\nRULE:ACK");
  assert.equal(tx.length, 2);
  assert.equal(tx[1].payload.operationId, sequence.attempts[0].operationId);
  assert.equal(tx[1].payload.outcome, "accepted");
  assert.equal(rule.source.direction, "rx");
  assert.equal(rule.source.sessionId, session.sessionId);
  assert.equal(rule.source.sessionEpoch, session.sessionEpoch);
  const byteStart = BigInt(rule.source.byteStart);
  const byteEnd = BigInt(rule.source.byteEnd);
  assert.equal(byteEnd - byteStart, 11n);
  const matched = rx.flatMap(({ payload }) => {
    const start = BigInt(payload.byteStart);
    const end = BigInt(payload.byteEnd);
    if (end <= byteStart || start >= byteEnd) return [];
    return [
      Buffer.from(payload.bytesBase64, "base64").subarray(
        Number((byteStart > start ? byteStart : start) - start),
        Number((byteEnd < end ? byteEnd : end) - start),
      ),
    ];
  });
  assert.equal(Buffer.concat(matched).toString("utf8"), "RULE:BENCH\n");
  const workspace = await readWorkspace();
  const deniedId = await armAndTrigger("RULE:BOUNDARY", {
    kind: "action",
    actionId: "workspace.save",
    params: { value: { ...workspace.value, name: "Unexpected rule target" } },
  });
  let denied;
  await expect
    .poll(async () => {
      denied = await getOperation(deniedId);
      return denied.state;
    })
    .toBe("failed");
  assert.deepEqual(denied.target, session);
  assert.equal(denied.childHighWatermark, "0");
  assert.equal(denied.error?.code, "NODE_ACTION_FAILED");
  const deniedRaw = await readRaw("rule-denied", after.nextEventSeq);
  const deniedTx = deniedRaw.events.filter(({ kind }) => kind === "tx");
  assert.equal(deniedTx.length, 1);
  assert.equal(text(deniedTx), "\nRULE:BOUNDARY\n");
  assert.equal(deniedTx[0].payload.outcome, "accepted");
  assert.deepEqual(await readWorkspace(), workspace);
  await close();
  return {
    denied: {
      operationId: deniedId,
      error: denied.error,
      workspaceRevision: workspace.revision,
      childHighWatermark: denied.childHighWatermark,
    },
    parentId,
    effectId,
    transmitId: tx[1].payload.operationId,
    source: rule.source,
    attemptedSequence: sequence.attempts[0],
  };
}
