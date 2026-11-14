import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

test("custom notifications cannot bypass the shared content container", async () => {
  const source =
    'import { toast } from "sonner";\nexport const notify = () => toast.custom(() => <div>Failure</div>);';
  const [feature] = await eslint.lintText(source, {
    filePath: "src/components/notification-probe.tsx",
  });
  assert.ok(
    feature.messages.some(
      (message) => message.ruleId === "no-restricted-properties",
    ),
  );
  const [shared] = await eslint.lintText(source, {
    filePath: "src/lib/notifications.tsx",
  });
  assert.ok(
    shared.messages.every(
      (message) => message.ruleId !== "no-restricted-properties",
    ),
  );
});

test("notification details use the shared floating panel instead of resizing the toast", async () => {
  for (const source of [
    ...["WorkbenchNotice", "NotificationContent"].map(
      (component) =>
        `export const Probe = () => <${component}><div><details><summary>Details</summary>Failure</details></div></${component}>;`,
    ),
    "export const Probe = () => notifyCustom(() => <details><summary>Details</summary>Failure</details>);",
    'import { toast } from "sonner";\nexport const Probe = () => toast.error("Failure", { description: <details><summary>Details</summary>Failure</details> });',
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "src/components/notification-probe.tsx",
    });
    assert.equal(result.fatalErrorCount, 0);
    assert.ok(
      result.messages.some((message) =>
        message.message.includes("NotificationDetails"),
      ),
    );
  }
  for (const source of [
    'export const Probe = () => <NotificationContent><NotificationDetails label="Details">Failure</NotificationDetails></NotificationContent>;',
    "export const Probe = () => <section><details><summary>Advanced</summary>Configuration</details></section>;",
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "src/components/notification-probe.tsx",
    });
    assert.equal(result.fatalErrorCount, 0);
    assert.ok(
      result.messages.every(
        (message) => !message.message.includes("NotificationDetails"),
      ),
    );
  }
});

test("upstream UI components still enforce the native facade boundary", async () => {
  for (const source of [
    'import { invoke } from "@tauri-apps/api/core";\nexport const Probe = () => <button onClick={() => invoke("unsafe")}>Run</button>;',
    'export async function probe() { return import("@tauri-apps/api/core"); }',
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "src/components/ui/boundary-probe.tsx",
    });
    assert.equal(result.fatalErrorCount, 0);
    assert.ok(
      result.messages.some((message) =>
        ["no-restricted-imports", "no-restricted-syntax"].includes(
          message.ruleId,
        ),
      ),
    );
  }
});

test("application modules reject imports after executable declarations", async () => {
  const [result] = await eslint.lintText(
    'export const ready = true;\nimport { cn } from "@/lib/utils";\nexport const classes = cn("flex");',
    { filePath: "src/pages/import-probe.tsx" },
  );
  assert.equal(result.fatalErrorCount, 0);
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "no-restricted-syntax",
    ),
  );
});

test("handwritten workspace packages enforce the native facade boundary", async () => {
  for (const source of [
    'import { invoke } from "@tauri-apps/api/core";\nexport const probe = invoke;',
    'export async function probe() { return import("@tauri-apps/api/core"); }',
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/host-client/src/boundary-probe.ts",
    });
    assert.equal(result.fatalErrorCount, 0);
    assert.ok(
      result.messages.some((message) =>
        ["no-restricted-imports", "no-restricted-syntax"].includes(
          message.ruleId,
        ),
      ),
    );
  }
});

test("handwritten workspace packages reject any and enum", async () => {
  const [result] = await eslint.lintText(
    "export enum Probe { Ready }\nexport const value: any = null;",
    { filePath: "packages/contracts/src/type-probe.ts" },
  );
  assert.equal(result.fatalErrorCount, 0);
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "@typescript-eslint/no-explicit-any",
    ),
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "no-restricted-syntax",
    ),
  );
});

test("Rust-generated workspace contracts are ignored by ESLint", async () => {
  assert.equal(
    await eslint.isPathIgnored("packages/contracts/src/generated/types.ts"),
    true,
  );
});
