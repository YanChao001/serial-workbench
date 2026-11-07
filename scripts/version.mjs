import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyFileChanges, projectFile } from "./fs-utils.mjs";
import { tagFromEnvironment, writeOutput } from "./hosting/github-env.mjs";

// SemVer 2.0 的数字标识不能有前导零，构建元数据不受此限制。
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function validateVersion(version, config) {
  const match = typeof version === "string" && version.match(SEMVER);
  if (!match) throw new Error(`Invalid SemVer version: ${version}`);
  const core = match.slice(1, 4).map(BigInt);
  if (core.some((part) => part > 18446744073709551615n)) {
    throw new Error("Version exceeds the integer range supported by Cargo");
  }
  const bundle = config.bundle;
  if (bundle?.active === false) return;
  const targets = bundle?.targets ?? "all";
  const includes = (target) =>
    targets === "all" ||
    targets === target ||
    targets.includes("all") ||
    targets.includes(target);
  if (includes("nsis") && core.some((part) => part > 65535n)) {
    throw new Error("NSIS version components must not exceed 65535");
  }
  if (includes("msi")) {
    const wixVersion = bundle?.windows?.wix?.version;
    if (wixVersion !== undefined && wixVersion !== null) {
      const wixParts =
        typeof wixVersion === "string" &&
        wixVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/);
      if (
        !wixParts ||
        wixParts
          .slice(1)
          .some(
            (part, index) =>
              part !== undefined && BigInt(part) > (index < 2 ? 255n : 65535n),
          )
      ) {
        throw new Error(
          "bundle.windows.wix.version must be a valid MSI version: major.minor.patch[.build] (255.255.65535[.65535])",
        );
      }
      return;
    }
    if (core[0] > 255n || core[1] > 255n || core[2] > 65535n) {
      throw new Error(
        "MSI version must satisfy major <= 255, minor <= 255, patch <= 65535",
      );
    }
    // Tauri 优先使用构建元数据，再使用预发布标识作为 MSI 可选的第四段。
    // 文本预发布标识需要显式配置 wix.version。
    const fourth = match[5] ?? match[4];
    if (fourth && (!/^\d+$/.test(fourth) || BigInt(fourth) > 65535n)) {
      throw new Error(
        "MSI prerelease identifiers or build metadata must be integers <= 65535; for text prereleases, configure bundle.windows.wix.version or build NSIS only",
      );
    }
  }
}

function tomlValue(content, key, label) {
  const match = content.match(
    new RegExp(
      "^\\s*" + key + "\\s*=\\s*[\"']([^\"'\\r\\n]+)[\"']\\s*(?:#.*)?$",
      "m",
    ),
  );
  if (!match) throw new Error(key + " was not found in " + label);
  return match[1];
}

export function readVersionFiles(root) {
  const originals = new Map();
  const read = (path) => {
    const content = readFileSync(projectFile(root, path), "utf8");
    originals.set(path, content);
    return content;
  };
  const packagePath = "package.json";
  const configPath = "src-tauri/tauri.conf.json";
  const manifestPath = "Cargo.toml";
  const lockPath = "Cargo.lock";
  const packageJson = JSON.parse(read(packagePath));
  const config = JSON.parse(read(configPath));
  const manifest = read(manifestPath);
  const sharedSection = manifest.match(
    /^\[workspace\.package\][^\S\r\n]*(?:#.*)?\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m,
  );
  if (!sharedSection)
    throw new Error("[workspace.package] was not found in Cargo.toml");
  const cargoVersion = tomlValue(sharedSection[1], "version", manifestPath);
  const members = manifest.match(/^\s*members\s*=\s*\[([^\]]*)\]/m);
  if (!members)
    throw new Error("workspace members were not found in Cargo.toml");
  const packageNames = [...members[1].matchAll(/["']([^"']+)["']/g)].map(
    (match) => {
      const path = match[1] + "/Cargo.toml";
      const member = read(path);
      const section = member.match(
        /^\[package\][^\S\r\n]*(?:#.*)?\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m,
      );
      if (
        !section ||
        !/^\s*version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(section[1])
      )
        throw new Error(path + " must use version.workspace = true");
      return tomlValue(section[1], "name", path);
    },
  );
  const files = [
    { path: packagePath, version: packageJson.version, json: packageJson },
    { path: configPath, version: config.version, json: config },
    {
      path: manifestPath,
      version: cargoVersion,
      content: manifest,
      section: sharedSection[0],
    },
  ];
  const packages = join(root, "packages");
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      const path = `packages/${entry.name}/package.json`;
      if (!entry.isDirectory() || !existsSync(join(root, path))) continue;
      const json = JSON.parse(read(path));
      files.push({ path, version: json.version, json });
    }
  }
  const lock = read(lockPath);
  const sections = [
    ...lock.matchAll(
      /^\[\[package\]\][^\S\r\n]*\r?\n([\s\S]*?)(?=^\[\[|(?![\s\S]))/gm,
    ),
  ];
  for (const name of packageNames) {
    const own = sections.filter(
      (section) =>
        tomlValue(section[1], "name", lockPath) === name &&
        !/^\s*source\s*=/m.test(section[1]),
    );
    if (own.length !== 1)
      throw new Error(
        "Cargo.lock must contain exactly one local package named " + name,
      );
    files.push({
      path: lockPath,
      version: tomlValue(own[0][1], "version", lockPath),
      content: lock,
      section: own[0][0],
    });
  }
  for (const file of files) file.before = originals.get(file.path);
  return { config, files };
}

export function checkVersionValues(config, files, tag) {
  const version = files[0].version;
  validateVersion(version, config);
  for (const file of files) {
    if (file.version !== version) {
      throw new Error(
        `${file.path} version ${file.version} does not match package.json version ${version}`,
      );
    }
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match project version v${version}`);
  }
  return version;
}

export function checkVersions(root, tag) {
  const { config, files } = readVersionFiles(root);
  return checkVersionValues(config, files, tag);
}

export function prepareVersionUpdates(root, next) {
  // 写入前先解析所有文件，并校验 Windows 安装包版本。
  const { config, files } = readVersionFiles(root);
  validateVersion(next, config);
  const updates = new Map();
  for (const file of files) {
    const current = updates.get(file.path)?.content ?? file.content;
    const content = file.json
      ? JSON.stringify({ ...file.json, version: next }, null, 2) + "\n"
      : current.replace(
          file.section,
          file.section.replace(
            /^(\s*version\s*=\s*)(["'])[^"'\r\n]+\2/m,
            (_, prefix, quote) => prefix + quote + next + quote,
          ),
        );
    updates.set(file.path, {
      path: file.path,
      before: file.before,
      content,
      previous: file.version,
    });
  }
  return [...updates.values()];
}

async function runCli(args) {
  const usage =
    "Usage: node scripts/version.mjs check [tag] | set <version>\nYou can also use pnpm version:check [tag] or pnpm version:set <version>.";
  const [mode, value] = args;
  const help = (argument) => ["--help", "-h"].includes(argument);
  if (
    (args.length === 1 && help(mode)) ||
    (args.length === 2 && ["check", "set"].includes(mode) && help(value))
  ) {
    console.log(usage);
    return;
  }
  if (
    !["check", "set"].includes(mode) ||
    (mode === "check" && args.length > 2) ||
    (mode === "set" && args.length !== 2) ||
    (value !== undefined && (!value || value.startsWith("-")))
  )
    throw new Error(usage);

  const root = resolve(import.meta.dirname, "..");
  if (mode === "check") {
    const tag = value ?? tagFromEnvironment();
    const version = checkVersions(root, tag);
    writeOutput("version", version);
    writeOutput("prerelease", version.split("+")[0].includes("-"));
    console.log(`Project versions match: ${version}${tag ? ` (${tag})` : ""}`);
    return;
  }

  const updates = prepareVersionUpdates(root, value);
  // check 和模块导入不依赖已安装的前端工具；只有写版本时加载格式化器。
  const { format, resolveConfig } = await import("prettier");
  for (const update of updates) {
    if (!update.path.endsWith(".json")) continue;
    const filepath = join(root, update.path);
    update.content = await format(update.content, {
      ...(await resolveConfig(filepath)),
      filepath,
    });
  }
  applyFileChanges({ root, changes: updates });
  console.log(`Version updated: ${updates[0].previous} -> ${value}`);
  for (const { path } of updates) console.log(`  ${path}`);
  console.log(
    `\nNext: commit the changes, create a tag (git tag -a v${value} -m "v${value}"), and push.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
