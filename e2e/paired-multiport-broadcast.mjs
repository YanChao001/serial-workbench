import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { expect } from "@playwright/test";

const tcpProvider = "swb.builtin.tcp.transport";
const broadcastName = /^(Multi-port broadcast|多端口广播)$/;
const closeView = /^(Close view|关闭视图)$/;
const echoName = "virtual:echo";
const receiptText = (bytes) =>
  new RegExp(
    "^(" +
      bytes +
      " bytes accepted · 0 bytes unconfirmed|已接纳 " +
      bytes +
      " 字节 · 未确认 0 字节)$",
  );

async function loopbackPort() {
  const reservation = createServer();
  const bound = once(reservation, "listening");
  reservation.listen({ host: "127.0.0.1", port: 0 });
  await bound;
  const { port } = reservation.address();
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function checkMultiportBroadcast({
  page,
  output,
  original,
  listSessions,
  readEcho,
  prepareTcpRaw,
  holdTcpLease,
  operation,
  submittedTx,
}) {
  const port = await loopbackPort();
  const viewport = page.viewportSize();
  const tcpTab = page.getByRole("tab", { name: tcpProvider, exact: true });
  let peer;
  try {
    await page.locator(".workbench-device-select").click();
    await page.getByRole("option", { name: tcpProvider, exact: true }).click();
    await page
      .getByRole("button", {
        name: /^(Open|打开) swb\.builtin\.tcp\.transport$/,
      })
      .click();
    const configure = page.getByRole("dialog", {
      name: /^(TCP connection|TCP 连接)$/,
    });
    await configure.getByRole("combobox", { name: /^(Role|角色)$/ }).click();
    await page
      .getByRole("option", { name: /^(TCP server|TCP 服务端)$/ })
      .click();
    await configure
      .getByRole("textbox", { name: /^(Port|端口)$/ })
      .fill(String(port));
    await configure
      .getByRole("button", { name: /^(Start listening|开始侦听)$/ })
      .click();
    await expect(configure).toBeHidden();
    await expect(tcpTab).toBeVisible();

    const sessions = await listSessions();
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.find(({ id }) => id === original.id),
      original,
    );
    const tcp = sessions.find(({ id }) => id !== original.id);
    assert.equal(tcp.hostId, original.hostId);
    const readTcp = await prepareTcpRaw(tcp);
    const targets = [
      { label: echoName, session: original, read: readEcho },
      { label: tcpProvider, session: tcp, read: readTcp },
    ];
    const panel = page.getByRole("dialog", { name: broadcastName });
    const results = panel.getByRole("region", {
      name: /^(Per-port results|逐端口结果)$/,
    });
    const confirm = panel.getByRole("button", {
      name: /^(Confirm and send in parallel|确认并行发送)$/,
    });
    async function open() {
      await page
        .getByRole("button", { name: /^(Workspace menu|工作区菜单)$/ })
        .press("ArrowDown");
      await page.getByRole("menuitem", { name: broadcastName }).click();
      await expect(panel).toBeVisible();
    }

    async function run(label, frame, accepted, cancelTcp = false) {
      const before = submittedTx();
      const positions = await Promise.all(
        targets.map(
          async (target, index) =>
            (await target.read(label + "-cursor-" + index)).nextEventSeq,
        ),
      );
      await open();
      for (const target of targets) {
        await panel
          .getByRole("checkbox", { name: target.label, exact: false })
          .check();
      }
      await panel
        .getByRole("textbox", {
          name: /^(Final bytes \(HEX\)|最终发送字节（HEX）)$/,
        })
        .fill(frame.toString("hex").match(/../g).join(" "));
      await expect(confirm).toBeEnabled();
      assert.equal(
        submittedTx(),
        before,
        "The preview sent bytes before confirmation",
      );
      await confirm.click();

      const receipts = [];
      for (const [index, target] of targets.entries()) {
        const row = results
          .getByRole("listitem")
          .filter({ hasText: target.label });
        let stoppedId;
        if (index === 1 && cancelTcp) {
          const stop = row.getByRole("button", {
            name: /^(Stop this port|停止此端口)$/,
          });
          await expect(stop).toBeEnabled();
          await expect(row.locator("code")).toHaveText(/^[a-f0-9-]{36}$/);
          stoppedId = await row.locator("code").textContent();
          const queued = await operation(stoppedId);
          assert.ok(["queued", "running"].includes(queued.state), queued.state);
          let waitingRead = 0;
          await expect
            .poll(async () => {
              const { events } = await target.read(
                label + "-waiting-" + waitingRead++,
                positions[index],
              );
              assert.equal(
                events.some(({ kind }) => kind === "tx"),
                false,
              );
              return events.some(
                ({ kind, payload }) =>
                  kind === "tx_intent" && payload.operationId === stoppedId,
              );
            })
            .toBe(true);
          await stop.click();
        }
        await expect(row.getByText(receiptText(accepted[index]))).toBeVisible();
        await expect(
          row.getByText(
            stoppedId
              ? /^(Stopped|已停止)$/
              : accepted[index] > 0
                ? /^(Write accepted|写入已接纳)$/
                : /^(Write rejected|写入被拒绝)$/,
          ),
        ).toBeVisible();
        const id = await row.locator("code").textContent();
        assert.ok(id);
        const op = await operation(id);
        assert.equal(op.operationId, id);
        if (stoppedId) {
          assert.equal(id, stoppedId);
          assert.equal(op.state, "cancelled");
        }
        if (accepted[index] > 0) assert.equal(op.state, "succeeded");
        assert.equal(op.executionMode, "independent");
        assert.deepEqual(op.target, target.session);
        assert.equal(op.result?.kind, "tx");
        const tx = op.result.value;
        assert.equal(tx.operationId, id);
        assert.equal(tx.sessionEpoch, target.session.sessionEpoch);
        assert.equal(tx.outcome, accepted[index] > 0 ? "accepted" : "rejected");
        assert.deepEqual(
          tx.acceptedRanges,
          accepted[index] > 0
            ? [{ start: "0", end: String(accepted[index]) }]
            : [],
        );
        assert.deepEqual(tx.unknownRanges, []);
        if (accepted[index] > 0) {
          assert.deepEqual(Buffer.from(tx.bytesBase64, "base64"), frame);
        }
        const raw = await target.read(
          label + "-settled-" + index,
          positions[index],
        );
        const writes = raw.events.filter(({ kind }) => kind === "tx");
        assert.deepEqual(
          writes.map(({ payload }) => payload.operationId),
          [id],
        );
        assert.deepEqual(writes[0].payload, tx);
        assert.equal(writes[0].hostId, target.session.hostId);
        assert.equal(writes[0].sessionId, target.session.id);
        assert.equal(writes[0].sessionEpoch, target.session.sessionEpoch);
        let echoBytesHex;
        if (index === 0) {
          let readNumber = 0;
          await expect
            .poll(async () => {
              const echo = await target.read(
                label + "-echo-" + readNumber++,
                positions[index],
              );
              const bytes = echo.events
                .filter(({ kind }) => kind === "rx")
                .map(({ payload }) =>
                  Buffer.from(payload.bytesBase64, "base64"),
                );
              echoBytesHex = Buffer.concat(bytes).toString("hex");
              return echoBytesHex;
            })
            .toBe(frame.toString("hex"));
        }
        receipts.push({
          target: target.label,
          sessionId: target.session.id,
          sessionEpoch: tx.sessionEpoch,
          operationId: id,
          rawEvent: writes[0].eventSeq,
          state: op.state,
          outcome: tx.outcome,
          acceptedBytes: accepted[index],
          unknownBytes: 0,
          echoBytesHex,
        });
      }
      assert.notEqual(receipts[0].operationId, receipts[1].operationId);
      assert.equal(submittedTx(), before + 2);
      await panel.getByRole("button", { name: closeView }).click();
      await expect(panel).toBeHidden();
      await open();
      for (const receipt of receipts)
        await expect(
          results.getByText(receipt.operationId, { exact: true }),
        ).toBeVisible();
      if (cancelTcp)
        await expect(results.getByText(/^(Stopped|已停止)$/)).toBeVisible();
      assert.equal(submittedTx(), before + 2, "Reopening submitted new TX");
      await results.screenshot({ path: join(output, label + "-results.png") });
      await panel.getByRole("button", { name: closeView }).click();
      await expect(panel).toBeHidden();
      return receipts;
    }

    const unattached = await run(
      "broadcast-peer-unattached",
      Buffer.from([0, 0xa5, 0xff, 10]),
      [4, 0],
    );

    peer = createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    peer.on("data", (chunk) => chunks.push(chunk));
    await once(peer, "connect");
    await page.setViewportSize({ width: 440, height: 650 });
    const sample = Buffer.from([0, 0xff, 13, 10, 128]);
    const attached = await run("broadcast-two-targets", sample, [5, 5]);
    await expect
      .poll(() => Buffer.concat(chunks).toString("hex"))
      .toBe(sample.toString("hex"));

    const held = await holdTcpLease();
    let stopped;
    try {
      stopped = await run(
        "broadcast-cancel-held-port",
        Buffer.of(0x43, 0, 0x54),
        [3, 0],
        true,
      );
      const lease = await operation(held.operationId);
      assert.equal(lease.state, "running");
      assert.equal(lease.result?.value.state, "active");
      assert.deepEqual(Buffer.concat(chunks), sample);
    } finally {
      await held.release();
    }

    await tcpTab.click();
    await page
      .getByRole("button", { name: /^(Close session|关闭会话)$/ })
      .click();
    await expect.poll(() => peer.readableEnded).toBe(true);
    assert.deepEqual(Buffer.concat(chunks), sample);
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: closeView })
      .click();
    await expect(tcpTab).toBeHidden();
    await page.getByRole("tab", { name: echoName, exact: true }).click();
    return {
      peerUnattached: unattached,
      bothAttached: attached,
      cancelledWhileHeld: stopped,
      blockedPortLeaseOperationId: held.operationId,
      tcpPeerBytesHex: Buffer.concat(chunks).toString("hex"),
      echoPeerBytesHex: [
        unattached[0].echoBytesHex,
        attached[0].echoBytesHex,
        stopped[0].echoBytesHex,
      ],
      reopenedWithoutResending: true,
      tcpPeerClosed: true,
    };
  } finally {
    peer?.destroy();
    if (viewport && !page.isClosed()) await page.setViewportSize(viewport);
  }
}
