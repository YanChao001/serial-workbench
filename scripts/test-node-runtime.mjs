import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  arch as osArch,
  cpus,
  release as osRelease,
  totalmem,
  version as osVersion,
} from "node:os";
import {
  validateHostError,
  validateNodeRuntimeSelfTest,
} from "../packages/contracts/src/generated/validators.mjs";
import { e2eSourceIdentity } from "../e2e/build.mjs";
import { fileSha256, publicationPath } from "./artifact-lib.mjs";
import { validateBinary } from "./components-build.mjs";
import { projectFile } from "./fs-utils.mjs";
import { inspectNodeRuntimeLayout } from "./node-runtime-layout.mjs";
import { loadNodeRuntimeRelease } from "./node-runtime-source.mjs";
import { loadNodeRuntimeLibrary } from "./node-runtime-library-source.mjs";

export function runNodeRuntimeSuite({
  root,
  target,
  resources,
  probe,
  output,
}) {
  root = resolve(root);
  const release = loadNodeRuntimeRelease(root),
    spec = release.targets.find((entry) => entry.target === target);
  if (!spec || spec.platform !== process.platform || spec.arch !== process.arch)
    throw new Error("Runtime suite requires its native target");
  resources = publicationPath(root, resources);
  probe = projectFile(root, relative(root, resolve(root, probe)));
  validateBinary(probe, target);
  const parent = publicationPath(
    root,
    output ?? join(root, ".cache/evidence/node-runtime"),
  );
  mkdirSync(parent, { recursive: true });
  const suite = mkdtempSync(join(parent, target + "-"));
  const results = [];
  let sourceFingerprint = null,
    phase = "setup";
  try {
    sourceFingerprint = e2eSourceIdentity(root);
    const probeSha256 = fileSha256(probe);
    const plan = { root, target },
      sourceFiles = inspectNodeRuntimeLayout(plan, resources);
    const product = JSON.parse(
      readFileSync(projectFile(root, "app.config.json"), "utf8"),
    ).name;
    if (
      typeof product !== "string" ||
      !product ||
      /[/\\:]/.test(product) ||
      product === "." ||
      product === ".."
    )
      throw new Error("Invalid product directory");
    const installation = join(suite, "installed 中文 with spaces");
    const resourceRoot =
      spec.platform === "darwin"
        ? join(installation, "Workbench.app/Contents/Resources")
        : spec.platform === "linux"
          ? join(installation, "usr/lib", product)
          : installation;
    const executable =
      spec.platform === "darwin"
        ? join(installation, "Workbench.app/Contents/MacOS/runtime-probe")
        : spec.platform === "linux"
          ? join(installation, "usr/bin/runtime-probe")
          : join(installation, "runtime-probe.exe");
    mkdirSync(resourceRoot, { recursive: true });
    mkdirSync(dirname(executable), { recursive: true });
    cpSync(join(resources, "runtime"), join(resourceRoot, "runtime"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    copyFileSync(probe, executable);
    assert.equal(fileSha256(executable), probeSha256);
    if (spec.platform !== "win32") chmodSync(executable, 0o755);
    assert.deepEqual(inspectNodeRuntimeLayout(plan, resourceRoot), sourceFiles);
    const run = (name, expected, args = [], environment = {}) => {
      const caseDirectory = join(suite, name);
      mkdirSync(caseDirectory);
      const result = spawnSync(
        executable,
        ["--evidence", caseDirectory, ...args],
        {
          cwd: suite,
          env: { ...process.env, ...environment },
          windowsHide: true,
          timeout: 45_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        },
      );
      writeFileSync(join(caseDirectory, "command.stdout"), result.stdout ?? "");
      writeFileSync(join(caseDirectory, "command.stderr"), result.stderr ?? "");
      if (result.error)
        writeFileSync(
          join(caseDirectory, "command-error.txt"),
          result.error.message,
        );
      assert.equal(result.error, undefined, `${name}: probe process failed`);
      assert.equal(
        result.status,
        expected === "success" ? 0 : 1,
        `${name}: unexpected exit status`,
      );
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.schemaVersion, "0.1");
      assert.ok(receipt.outcome && typeof receipt.outcome.ok === "boolean");
      if (expected === "success") {
        assert.equal(receipt.outcome.ok, true);
        const value = receipt.outcome.result;
        assert.ok(validateNodeRuntimeSelfTest(value));
        assert.equal(value.version, release.version);
        assert.equal(value.modulesAbi, release.modulesAbi);
        assert.equal(value.nodeApiVersion, release.nodeApiVersion);
        assert.equal(value.platform, spec.platform);
        assert.equal(value.arch, spec.arch);
        if (spec.platform === "linux")
          assert.ok(
            [
              "/memfd:serial-workbench-node",
              "/memfd:serial-workbench-node (deleted)",
            ].includes(value.execPath),
          );
        else
          assert.equal(
            realpathSync(value.execPath),
            realpathSync(join(resourceRoot, spec.executable.resourcePath)),
          );
      } else {
        assert.equal(receipt.outcome.ok, false);
        assert.ok(validateHostError(receipt.outcome.error));
        assert.equal(receipt.outcome.error.code, expected);
        assert.ok(
          !JSON.stringify(receipt.outcome.error).includes("installed 中文"),
        );
      }
      if (expected === "success" || name === "output-budget") {
        if (spec.platform === "linux")
          assert.equal(receipt.diagnostics?.imageSealed, true);
        if (spec.platform === "darwin") {
          const image = JSON.parse(
            readFileSync(join(resourceRoot, "runtime/node-image.json"), "utf8"),
          );
          assert.equal(
            receipt.diagnostics?.imageCdhash,
            image.codeDirectoryHash,
          );
          assert.equal(
            receipt.diagnostics?.imageSignatureFlags & 0x10301,
            0x10301,
          );
          assert.equal(
            receipt.diagnostics?.imageSignatureFlags & 0x10000024,
            0,
          );
        }
        assert.ok(
          Number.isInteger(receipt.diagnostics?.processId) &&
            receipt.diagnostics.processId > 0,
          `${name}: actual Node child evidence is required`,
        );
      }
      if (receipt.diagnostics?.processId) {
        assert.equal(receipt.diagnostics.reaped, true);
        assert.throws(
          () => process.kill(receipt.diagnostics.processId, 0),
          (error) => error.code === "ESRCH",
          `${name}: Node child remains alive`,
        );
      }
      results.push({ name, expected, passed: true, receipt });
      console.log(`Runtime case passed: ${name}`);
      return receipt;
    };
    const moved = (path, name, operation) => {
      const backup = join(suite, name + ".original");
      renameSync(path, backup);
      try {
        operation(backup);
      } finally {
        renameSync(backup, path);
      }
    };
    const edited = (path, name, operation) => {
      const original = readFileSync(path);
      writeFileSync(join(suite, name + ".original"), original);
      try {
        operation();
      } catch (error) {
        copyFileSync(path, join(suite, name + ".rejected"));
        throw error;
      } finally {
        writeFileSync(path, original);
      }
    };
    const patched = (path, name, position, replacement, operation) => {
      const original = Buffer.alloc(replacement.length);
      const handle = openSync(path, "r+");
      try {
        assert.equal(
          readSync(handle, original, 0, original.length, position),
          original.length,
        );
        assert.equal(
          writeSync(handle, replacement, 0, replacement.length, position),
          replacement.length,
        );
      } finally {
        closeSync(handle);
      }
      writeFileSync(
        join(suite, name + ".patch.json"),
        JSON.stringify(
          {
            position,
            original: original.toString("hex"),
            replacement: replacement.toString("hex"),
            sha256: fileSha256(path),
          },
          null,
          2,
        ) + "\n",
      );
      try {
        operation();
      } catch (error) {
        copyFileSync(path, join(suite, name + ".rejected"));
        throw error;
      } finally {
        const restore = openSync(path, "r+");
        try {
          assert.equal(
            writeSync(restore, original, 0, original.length, position),
            original.length,
          );
        } finally {
          closeSync(restore);
        }
      }
    };
    phase = "cases";
    const fakePath = join(suite, "fake-path");
    mkdirSync(fakePath);
    writeFileSync(
      join(fakePath, spec.platform === "win32" ? "node.exe" : "node"),
      "not executable system Node",
    );
    run("native-installed-layout", "success", [], {
      PATH:
        fakePath +
        (process.platform === "win32" ? ";" : ":") +
        process.env.PATH,
      NODE_OPTIONS: "--require " + join(suite, "injected-missing-module.cjs"),
      NODE_PATH: join(suite, "injected-node-path"),
      LD_LIBRARY_PATH: join(suite, "injected-library-path"),
      APPDIR: join(suite, "unrelated-appdir"),
    });
    const limited = run("output-budget", "LIMIT_EXCEEDED", [
      "--max-output-bytes",
      "8",
    ]);
    assert.ok(
      limited.diagnostics.stdoutBytes + limited.diagnostics.stderrBytes <= 8,
    );
    run("cancel-before-admission", "CANCELLED", ["--cancel"]);
    assert.equal(
      run("expired-before-spawn", "NODE_RUNTIME_START_TIMEOUT", [
        "--probe-timeout-ms",
        "0",
      ]).diagnostics.processId,
      null,
    );
    const descriptor = join(resourceRoot, "runtime/node-release.json");
    moved(descriptor, "descriptor", () =>
      run("missing-descriptor", "NODE_RUNTIME_MISSING"),
    );
    edited(descriptor, "descriptor-abi", () => {
      const value = JSON.parse(readFileSync(descriptor, "utf8"));
      value.modulesAbi = "148";
      writeFileSync(descriptor, JSON.stringify(value));
      run("altered-abi", "NODE_RUNTIME_INCOMPATIBLE");
    });
    const node = join(resourceRoot, spec.executable.resourcePath);
    moved(node, "node", () => run("missing-node", "NODE_RUNTIME_MISSING"));
    // 原始二进制只改一个尾字节，保留完整大小和架构；拒绝必须发生在启动之前。
    const descriptorHandle = openSync(node, "r"),
      byte = Buffer.alloc(1),
      position = lstatSync(node).size - 1;
    try {
      assert.equal(readSync(descriptorHandle, byte, 0, 1, position), 1);
    } finally {
      closeSync(descriptorHandle);
    }
    patched(node, "corrupt-node", position, Buffer.from([byte[0] ^ 1]), () => {
      assert.equal(
        run("corrupt-node", "NODE_RUNTIME_INTEGRITY_FAILED").diagnostics,
        null,
      );
    });
    const header = Buffer.alloc(64),
      binary = openSync(node, "r");
    try {
      assert.equal(
        readSync(binary, header, 0, header.length, 0),
        header.length,
      );
    } finally {
      closeSync(binary);
    }
    const archPosition =
      spec.platform === "win32"
        ? header.readUInt32LE(60) + 4
        : spec.platform === "linux"
          ? 18
          : 4;
    const arch = Buffer.alloc(spec.platform === "darwin" ? 4 : 2);
    if (spec.platform === "win32") arch.writeUInt16LE(0xaa64);
    else if (spec.platform === "linux") arch.writeUInt16LE(183);
    else arch.writeUInt32LE(spec.arch === "x64" ? 0x0100000c : 0x01000007);
    patched(node, "foreign-target", archPosition, arch, () => {
      assert.equal(
        run("foreign-executable-target", "NODE_RUNTIME_TARGET_UNSUPPORTED")
          .diagnostics,
        null,
      );
    });
    const runtime = join(resourceRoot, "runtime");
    moved(runtime, "runtime", (backup) => {
      symlinkSync(
        backup,
        runtime,
        process.platform === "win32" ? "junction" : "dir",
      );
      try {
        run("runtime-directory-link", "NODE_RUNTIME_INTEGRITY_FAILED");
      } finally {
        assert.ok(lstatSync(runtime).isSymbolicLink());
        publicationPath(root, dirname(runtime));
        rmSync(runtime, { recursive: true });
      }
    });
    if (spec.platform === "linux") {
      const library = loadNodeRuntimeLibrary(root),
        base = dirname(dirname(node));
      moved(join(base, library.sonameLink.resourcePath), "soname", () =>
        run("missing-private-soname", "NODE_RUNTIME_DEPENDENCY_MISSING"),
      );
    }
    phase = "restoration";
    assert.deepEqual(inspectNodeRuntimeLayout(plan, resourceRoot), sourceFiles);
    assert.equal(fileSha256(probe), probeSha256);
    assert.equal(fileSha256(executable), probeSha256);
    assert.equal(e2eSourceIdentity(root), sourceFingerprint);
    const receipt = {
      schemaVersion: "0.1",
      target,
      sourceFingerprint,
      probeSha256,
      resources,
      sourceFiles,
      suite,
      results,
      installationFixture: true,
      environment: {
        arch: osArch(),
        osRelease: osRelease(),
        osVersion: osVersion(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        cpuCount: cpus().length,
        totalMemoryBytes: String(totalmem()),
      },
      realInstaller: false,
      networkIsolated: false,
      guiStarted: false,
    };
    writeFileSync(
      join(suite, "suite.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    return receipt;
  } catch (error) {
    writeFileSync(
      join(suite, "failure.json"),
      JSON.stringify(
        { target, phase, sourceFingerprint, results, error: error.message },
        null,
        2,
      ) + "\n",
    );
    throw new Error(`${error.message}; runtime evidence retained: ${suite}`, {
      cause: error,
    });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const options = { root: resolve(import.meta.dirname, "..") },
      args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const key = {
          "--target": "target",
          "--resources": "resources",
          "--probe": "probe",
          "--output": "output",
        }[args[i]],
        value = args[++i];
      if (!key || !value || value.startsWith("--"))
        throw new Error(
          "Usage: node scripts/test-node-runtime.mjs --target <triple> --resources <built-resource-root> --probe <built-probe> [--output <project-directory>]",
        );
      options[key] = value;
    }
    if (!options.target || !options.resources || !options.probe)
      throw new Error("Target, built resources and built probe are required");
    const receipt = runNodeRuntimeSuite(options);
    console.log(
      `Runtime suite passed: ${receipt.results.length} cases; ${receipt.suite}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
