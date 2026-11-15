import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateNodeRuntimeSelfTest } from "../packages/contracts/src/generated/validators.mjs";
import { fileSha256, publicationPath } from "./artifact-lib.mjs";
import { validateBinary } from "./components-build.mjs";
import { projectFile, removeProjectPath } from "./fs-utils.mjs";
import { prepareMacRuntimeImage } from "./node-runtime-sign.mjs";
import {
  loadNodeRuntimeRelease,
  verifyRuntimeChecksums,
} from "./node-runtime-source.mjs";
import {
  loadNodeRuntimeLibrary,
  verifyRuntimeLibrarySources,
} from "./node-runtime-library-source.mjs";

function tool(command, args, options = {}) {
  const { logBase, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    windowsHide: true,
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...spawnOptions,
  });
  if (logBase) {
    writeFileSync(logBase + ".stdout", result.stdout ?? Buffer.alloc(0), {
      flag: "wx",
    });
    writeFileSync(logBase + ".stderr", result.stderr ?? Buffer.alloc(0), {
      flag: "wx",
    });
    if (result.error)
      writeFileSync(logBase + ".error", result.error.message, { flag: "wx" });
  }
  if (result.error || result.status !== 0)
    throw new Error(
      `Runtime preparation tool failed: ${command}: ${result.error?.message ?? result.stderr?.toString("utf8") ?? result.status}`,
    );
  return { stdout: result.stdout, stderr: result.stderr };
}

function verifiedFile(file, expected, label) {
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    BigInt(info.size) !== BigInt(expected.size)
  )
    throw new Error(`${label} size/type mismatch`);
  if (fileSha256(file) !== expected.sha256)
    throw new Error(`${label} hash mismatch`);
  return file;
}

function copyVerified(source, destination, expected, label) {
  verifiedFile(source, expected, label);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  verifiedFile(destination, expected, label);
  return destination;
}

function runtimeEnvironment(spec, targetDirectory) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:NODE_|LD_|DYLD_|OPENSSL_)/i.test(key),
    ),
  );
  if (spec.platform === "linux") {
    env.LD_LIBRARY_PATH = join(targetDirectory, "lib");
    env.LD_DEBUG = "libs";
  }
  return env;
}

function selfTest(executable, spec, release, targetDirectory, stage) {
  if (process.platform !== spec.platform || process.arch !== spec.arch)
    throw new Error("Runtime self-test requires its native target");
  const script =
    "console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,modulesAbi:process.versions.modules,nodeApiVersion:process.versions.napi,execPath:process.execPath}))";
  const result = tool(executable, ["--input-type=module", "--eval", script], {
    cwd: targetDirectory,
    env: runtimeEnvironment(spec, targetDirectory),
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    logBase: join(stage, "self-test"),
  });
  const probe = JSON.parse(result.stdout.toString("utf8"));
  if (
    !validateNodeRuntimeSelfTest(probe) ||
    probe.version !== release.version ||
    probe.platform !== spec.platform ||
    probe.arch !== spec.arch ||
    probe.modulesAbi !== release.modulesAbi ||
    probe.nodeApiVersion !== release.nodeApiVersion ||
    realpathSync(probe.execPath) !== realpathSync(executable)
  )
    throw new Error("Runtime self-test version/ABI/identity mismatch");
  let privateLibraryLoaded = false;
  if (spec.platform === "linux") {
    const library = join(targetDirectory, "lib", "libatomic.so.1");
    privateLibraryLoaded = result.stderr
      .toString("utf8")
      .split(/\r?\n/)
      .some(
        (line) =>
          line.includes("calling init:") && line.trim().endsWith(library),
      );
    if (!privateLibraryLoaded)
      throw new Error("Runtime did not observe the private libatomic load");
  }
  return { probe, privateLibraryLoaded };
}

function debFile(deb, entry) {
  if (process.platform === "linux") {
    const tar = tool("dpkg-deb", ["--fsys-tarfile", deb]).stdout;
    return tool("tar", ["-xOf", "-", "./" + entry], {
      input: tar,
      stdio: ["pipe", "pipe", "pipe"],
    }).stdout;
  }
  // 非 Linux 的静态资源检查使用系统 libarchive，不启动库文件。
  const tar = tool("tar", ["-xOf", deb, "data.tar.zst"]).stdout;
  return tool("tar", ["-xOf", "-", "./" + entry], {
    input: tar,
    stdio: ["pipe", "pipe", "pipe"],
  }).stdout;
}

/** 仅消费已下载且锁定的来源；输出唯一版本现场，失败不覆盖任何既有安装。 */
export function prepareNodeRuntime({
  root,
  target,
  archiveDirectory,
  artifactDirectory,
  outputDirectory,
  runSelfTest = true,
}) {
  root = realpathSync(root);
  const release = loadNodeRuntimeRelease(root),
    spec = release.targets.find((s) => s.target === target);
  if (!spec) throw new Error("Unsupported Node runtime target");
  const parent = publicationPath(
    root,
    outputDirectory ?? join(root, ".cache/node-runtime/layouts"),
  );
  const archive = resolve(archiveDirectory, spec.archive.name);
  verifiedFile(archive, spec.archive, "Node archive");
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, target + "-")),
    work = join(stage, "work"),
    resources = join(stage, "resources"),
    materials = join(resources, "runtime", "materials", release.id);
  mkdirSync(work);
  mkdirSync(resources);
  mkdirSync(materials, { recursive: true });
  try {
    const source = verifyRuntimeChecksums({
      release,
      cache: work,
      publicKey: readFileSync(
        projectFile(root, release.upstream.publicKeyPath),
      ),
      signedChecksums: readFileSync(
        projectFile(root, "resources/runtime/SHASUMS256.txt.asc"),
      ),
    });
    for (const [path, sha256] of [
      [release.upstream.publicKeyPath, release.upstream.publicKeySha256],
      [
        "resources/runtime/SHASUMS256.txt.asc",
        release.upstream.checksumsSha256,
      ],
    ]) {
      const input = projectFile(root, path);
      copyVerified(
        input,
        join(materials, path.split("/").at(-1)),
        { size: String(lstatSync(input).size), sha256 },
        "Node source evidence",
      );
    }
    const releaseJson = JSON.stringify(release, null, 2) + "\n";
    writeFileSync(
      join(resources, "runtime", "node-release.json"),
      releaseJson,
      { flag: "wx" },
    );
    writeFileSync(join(materials, "node-release.json"), releaseJson, {
      flag: "wx",
    });
    const localArchive = copyVerified(
      archive,
      join(work, spec.archive.name),
      spec.archive,
      "Node archive",
    );
    const extracted = join(work, "node");
    mkdirSync(extracted);
    tool(
      "tar",
      [
        "-xf",
        localArchive,
        "-C",
        extracted,
        "--no-same-owner",
        "--",
        spec.executable.archivePath,
        spec.license.archivePath,
      ],
      { logBase: join(stage, "node-extraction") },
    );
    for (const file of [spec.executable, spec.license])
      copyVerified(
        projectFile(extracted, file.archivePath),
        join(resources, file.resourcePath),
        file,
        "Node payload",
      );
    const executable = join(resources, spec.executable.resourcePath),
      targetDirectory = dirname(dirname(executable));
    validateBinary(executable, target);
    if (spec.platform !== "win32") chmodSync(executable, 0o755);
    let librarySource;
    if (spec.requiredPrivateLibraries.length) {
      if (!artifactDirectory)
        throw new Error("Private library artifacts directory is required");
      const library = loadNodeRuntimeLibrary(root);
      writeFileSync(
        join(materials, "libatomic-jammy.json"),
        JSON.stringify(library, null, 2) + "\n",
        { flag: "wx" },
      );
      librarySource = verifyRuntimeLibrarySources({
        root,
        cache: work,
        release: library,
      });
      for (const artifact of library.artifacts) {
        const name = artifact.filename.split("/").at(-1);
        copyVerified(
          join(artifactDirectory, name),
          join(materials, name),
          artifact,
          "Library source artifact",
        );
      }
      const packageFile = (name) =>
        join(
          materials,
          library.artifacts
            .find((a) => a.kind === "binary" && a.package === name)
            .filename.split("/")
            .at(-1),
        );
      const actual = debFile(
        packageFile("libatomic1"),
        library.library.archivePath,
      );
      const destination = join(targetDirectory, library.library.resourcePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, actual, { flag: "wx", mode: 0o644 });
      chmodSync(destination, 0o644);
      verifiedFile(destination, library.library, "Private library");
      validateBinary(destination, target);
      const notice = debFile(
        packageFile("gcc-12-base"),
        library.copyright.archivePath,
      );
      const noticePath = join(targetDirectory, library.copyright.resourcePath);
      mkdirSync(dirname(noticePath), { recursive: true });
      writeFileSync(noticePath, notice, { flag: "wx" });
      verifiedFile(noticePath, library.copyright, "Library copyright");
      copyVerified(
        projectFile(root, library.gplSourcePath),
        join(targetDirectory, library.gplLicense.resourcePath),
        library.gplLicense,
        "Library GPL license",
      );
      symlinkSync(
        library.sonameLink.target,
        join(targetDirectory, library.sonameLink.resourcePath),
      );
      // 对应源码与签名链进入同一分发材料目录，和运行时文件分别收集。
      for (const file of [
        library.upstream.keyring,
        library.upstream.inRelease,
        library.upstream.packageIndex,
        library.upstream.sourceIndex,
      ])
        copyVerified(
          projectFile(root, file.bundledPath),
          join(materials, file.bundledPath.split("/").at(-1)),
          file,
          "Library source evidence",
        );
    }
    const image =
      spec.platform === "darwin" && process.platform === "darwin"
        ? prepareMacRuntimeImage({
            root,
            stage,
            resources,
            materials,
            executable,
            spec,
            run: tool,
          })
        : null;
    const observed = runSelfTest
      ? selfTest(executable, spec, release, targetDirectory, stage)
      : null;
    const manifest = {
      schemaVersion: 1,
      runtimeRef: release.id,
      target,
      version: release.version,
      modulesAbi: release.modulesAbi,
      nodeApiVersion: release.nodeApiVersion,
      source: { ...source, checksums: Object.fromEntries(source.checksums) },
      librarySource: librarySource ?? null,
      image: image?.identity ?? null,
      selfTest: observed,
      resources: relative(root, resources).split(sep).join("/"),
    };
    writeFileSync(
      join(stage, "runtime-preparation.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx" },
    );
    removeProjectPath(root, relative(root, work));
    return {
      stage,
      resources,
      materials,
      executable,
      manifest,
      imageBinding: image?.binding ?? null,
    };
  } catch (error) {
    throw new Error(
      `${error.message}; runtime preparation retained: ${stage}`,
      { cause: error },
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(
      "Usage: pnpm runtime:prepare --target <triple> --archives <directory> [--artifacts <directory>] [--out <project-directory>] [--no-self-test]\nConsumes pinned cached sources. Linux requires both binary packages and all corresponding-source artifacts. Self-test runs the selected Node from the staged resource root.",
    );
  } else {
    try {
      const options = { root: resolve(import.meta.dirname, "..") };
      const names = {
        "--target": "target",
        "--archives": "archiveDirectory",
        "--artifacts": "artifactDirectory",
        "--out": "outputDirectory",
      };
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--no-self-test") {
          options.runSelfTest = false;
          continue;
        }
        const name = names[arg],
          value = args[++i];
        if (!name || !value || value.startsWith("--"))
          throw new Error("Invalid runtime preparation arguments");
        options[name] = value;
      }
      if (!options.target || !options.archiveDirectory)
        throw new Error("Runtime target and archives directory are required");
      const result = prepareNodeRuntime(options);
      console.log(
        JSON.stringify(
          {
            stage: result.stage,
            resources: result.resources,
            materials: result.materials,
            manifest: result.manifest,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(`Node runtime preparation failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
