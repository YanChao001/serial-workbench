import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cachePinnedRuntimeFile } from "./node-runtime-download.mjs";

const root = resolve(import.meta.dirname, "..");
const bytes = Buffer.from("pinned runtime archive");
const source = {
  url: "https://nodejs.org/download/release/v26.13.0/node-v26.13.0-win-x64.zip",
  name: "node-v26.13.0-win-x64.zip",
  size: String(bytes.length),
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
function fixture() {
  const parent = join(root, ".cache", "node-runtime-download-tests");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "case-"));
}

test("publishes only complete pinned bytes, reuses verified cache without network and never overwrites a bad cache", async () => {
  const cacheDirectory = fixture();
  let calls = 0;
  const fetch = async (url, options) => {
    calls++;
    assert.equal(url, source.url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers["Accept-Encoding"], "identity");
    return new Response(bytes, {
      headers: { "Content-Length": String(bytes.length) },
    });
  };
  const options = { root, cacheDirectory, source, fetch };
  const file = await cachePinnedRuntimeFile(options);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(
    await cachePinnedRuntimeFile({ ...options, offline: true }),
    file,
  );
  assert.equal(calls, 1);
  writeFileSync(file, "changed");
  await assert.rejects(
    cachePinnedRuntimeFile(options),
    /cached.*size|cached.*hash/i,
  );
  assert.equal(readFileSync(file, "utf8"), "changed");
  assert.equal(calls, 1);
});

test("rejects redirects, oversized and truncated bodies, wrong hashes and transport errors with retained evidence", async () => {
  for (const fetch of [
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.org/" },
      }),
    async () => new Response(Buffer.concat([bytes, bytes])),
    async () => new Response(bytes.subarray(1)),
    async () => new Response(Buffer.alloc(bytes.length)),
    async () => {
      throw new Error("connection failed");
    },
  ]) {
    const cacheDirectory = fixture();
    await assert.rejects(
      cachePinnedRuntimeFile({ root, cacheDirectory, source, fetch }),
    );
    assert.ok(!readdirSync(cacheDirectory).includes(source.name));
    const attempt = readdirSync(join(cacheDirectory, "attempts"));
    assert.equal(attempt.length, 1);
    const evidence = join(cacheDirectory, "attempts", attempt[0]);
    const failure = JSON.parse(
      readFileSync(join(evidence, "failure.json"), "utf8"),
    );
    assert.equal(failure.source.sha256, source.sha256);
    assert.ok(failure.error);
  }
});

test("offline misses, unsafe destinations and nonofficial URLs never start a request", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error("unexpected request");
  };
  const options = { root, cacheDirectory: fixture(), source, fetch };
  await assert.rejects(
    cachePinnedRuntimeFile({ ...options, offline: true }),
    /offline/i,
  );
  for (const cacheDirectory of [root, resolve(root, "..", "outside-runtime")])
    await assert.rejects(
      cachePinnedRuntimeFile({ ...options, cacheDirectory }),
      /publication|outside|root/i,
    );
  for (const url of [
    "http://nodejs.org/a",
    "https://example.org/a",
    source.url + "?mirror=1",
    "https://user:pass@nodejs.org/a",
  ])
    await assert.rejects(
      cachePinnedRuntimeFile({ ...options, source: { ...source, url } }),
      /source|URL/i,
    );
  assert.equal(calls, 0);
});

test("retries a transient connection failure once and retains each failed attempt", async () => {
  for (const recover of [true, false]) {
    const cacheDirectory = fixture();
    let calls = 0;
    const download = cachePinnedRuntimeFile({
      root,
      cacheDirectory,
      source,
      fetch: async (url) => {
        assert.equal(url, source.url);
        calls++;
        if (recover && calls === 2) return new Response(bytes);
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection timed out"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        });
      },
    });
    if (recover) assert.deepEqual(readFileSync(await download), bytes);
    else await assert.rejects(download, /UND_ERR_CONNECT_TIMEOUT/);
    assert.equal(calls, 2);
    const attempts = join(cacheDirectory, "attempts");
    const outcomes = readdirSync(attempts).map((name) =>
      readdirSync(join(attempts, name)).includes("failure.json"),
    );
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes.filter(Boolean).length, recover ? 1 : 2);
  }
});

test("cancellation stops the stream before returning and retains the attempted download", async () => {
  const cacheDirectory = fixture(),
    controller = new AbortController();
  let closed = false;
  const fetch = async (_url, options) =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(bytes.subarray(0, 3));
          options.signal.addEventListener(
            "abort",
            () => {
              closed = true;
              stream.error(options.signal.reason);
            },
            { once: true },
          );
          queueMicrotask(() =>
            controller.abort(new Error("cancelled by caller")),
          );
        },
      }),
    );
  await assert.rejects(
    cachePinnedRuntimeFile({
      root,
      cacheDirectory,
      source,
      fetch,
      signal: controller.signal,
    }),
    /cancel/i,
  );
  assert.equal(closed, true);
  assert.ok(!readdirSync(cacheDirectory).includes(source.name));
});

test("timeout aborts an incomplete response, closes the writer and preserves the received prefix", async () => {
  const cacheDirectory = fixture();
  let stopped = false;
  const fetch = async (_url, options) =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(bytes.subarray(0, 3));
          options.signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              stream.error(options.signal.reason);
            },
            { once: true },
          );
        },
      }),
    );
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    await assert.rejects(
      cachePinnedRuntimeFile({
        root,
        cacheDirectory,
        source,
        fetch,
        timeoutMs: 40,
      }),
      /timeout/i,
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(stopped, true);
  const attempt = readdirSync(join(cacheDirectory, "attempts"))[0];
  assert.deepEqual(
    readFileSync(join(cacheDirectory, "attempts", attempt, "payload.partial")),
    bytes.subarray(0, 3),
  );
  assert.ok(!readdirSync(cacheDirectory).includes(source.name));
});
