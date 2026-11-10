import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "ci-linux-deps.sh");
const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const sedProbe = spawnSync(bash, ["-c", "command -v sed && sed --version"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10_000,
});
const gnuSed = sedProbe.status === 0 && /\bGNU sed\b/.test(sedProbe.stdout);
const skipReason = gnuSed
  ? false
  : "Requires Bash with GNU sed for Linux dependency fixtures; " +
    (sedProbe.error?.message ||
      sedProbe.stderr?.trim() ||
      "GNU sed unavailable");
// macOS 默认 BSD sed 不执行 GNU/Linux 夹具；Linux CI 缺依赖必须失败。
if (process.platform === "linux") assert.equal(skipReason, false, skipReason);
const posix = (path) =>
  process.platform === "win32"
    ? "/" + path[0].toLowerCase() + path.slice(2).replaceAll("\\", "/")
    : path;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ci-linux-deps-"));
  t.after(() => {
    const target = resolve(root);
    const withinTemp = relative(resolve(tmpdir()), target);
    assert.ok(withinTemp && !isAbsolute(withinTemp));
    assert.notEqual(withinTemp, "..");
    assert.equal(withinTemp.startsWith(".." + sep), false);
    assert.ok(basename(target).startsWith("ci-linux-deps-"));
    rmSync(target, { recursive: true, force: true });
  });
  const apt = join(root, "apt config");
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  mkdirSync(join(apt, "sources.list.d"), { recursive: true });
  mkdirSync(bin);
  const executable = (name, body) =>
    writeFileSync(join(bin, name), "#!/usr/bin/env bash\nset -eu\n" + body, {
      mode: 0o755,
    });
  executable("sudo", 'exec "$@"\n');
  executable(
    "apt-get",
    `printf 'apt:%s' "$DEBIAN_FRONTEND" >> "$TEST_LOG"
printf '\\t%s' "$@" >> "$TEST_LOG"
printf '\\n' >> "$TEST_LOG"
for argument in "$@"; do
  if [[ "$argument" == --download-only ]]; then exit "$TEST_DOWNLOAD_FAILURE"; fi
done
`,
  );
  executable(
    "timeout",
    `printf 'timeout' >> "$TEST_LOG"
printf '\\t%s' "$1" "$2" "$3" >> "$TEST_LOG"
printf '\\n' >> "$TEST_LOG"
[[ "$TEST_TIMEOUT_FAILURE" == 0 ]] || exit "$TEST_TIMEOUT_FAILURE"
shift 3
exec "$@"
`,
  );
  const run = (body, args = [], env = {}) =>
    spawnSync(
      bash,
      [
        "-c",
        'export PATH="$1:$PATH"; source "$2"; ' + body,
        "--",
        posix(bin),
        posix(script),
        ...args,
      ],
      {
        env: {
          ...process.env,
          TEST_LOG: posix(log),
          TEST_DOWNLOAD_FAILURE: "0",
          TEST_TIMEOUT_FAILURE: "0",
          ...env,
        },
        encoding: "utf8",
        windowsHide: true,
      },
    );
  return {
    apt,
    log,
    run,
    commands: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("\t"))
        : [],
  };
}

test(
  "rewrites actual runner mirror and source files precisely while preserving security and signatures",
  { skip: skipReason },
  (t) => {
    const f = fixture(t);
    const mirror = join(f.apt, "apt-mirrors.txt");
    const legacy = join(f.apt, "sources.list");
    const deb822 = join(f.apt, "sources.list.d", "ubuntu.sources");
    const thirdParty = join(f.apt, "sources.list.d", "vendor.list");
    writeFileSync(
      mirror,
      "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\nhttps://packages.microsoft.com/ubuntu/22.04/prod\tpriority:4\n",
    );
    writeFileSync(
      legacy,
      "deb http://azure.archive.ubuntu.com/ubuntu jammy main restricted\ndeb https://security.ubuntu.com/ubuntu/ jammy-security main\n",
    );
    writeFileSync(
      deb822,
      "Types: deb\nURIs: https://azure.archive.ubuntu.com/ubuntu/\nSuites: jammy jammy-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
    );
    const vendor =
      "deb [signed-by=/keys/vendor.gpg] https://packages.microsoft.com/ubuntu/22.04/prod jammy main\ndeb https://azureXarchive.ubuntu.com/ubuntu/ jammy main\ndeb https://azure.archive.ubuntu.com/ubuntu-extra/ jammy main\n";
    writeFileSync(thirdParty, vendor);
    const first = f.run('prefer_ubuntu_archive "$3"', [posix(f.apt)]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      readFileSync(mirror, "utf8"),
      "https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\nhttps://packages.microsoft.com/ubuntu/22.04/prod\tpriority:4\n",
    );
    assert.equal(
      readFileSync(legacy, "utf8"),
      "deb https://archive.ubuntu.com/ubuntu/ jammy main restricted\ndeb https://security.ubuntu.com/ubuntu/ jammy-security main\n",
    );
    assert.equal(
      readFileSync(deb822, "utf8"),
      "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu/\nSuites: jammy jammy-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
    );
    assert.equal(readFileSync(thirdParty, "utf8"), vendor);
    const before = readFileSync(mirror, "utf8");
    const second = f.run('prefer_ubuntu_archive "$3"', [posix(f.apt)]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(mirror, "utf8"), before);
    assert.deepEqual(f.commands(), []);
  },
);

for (const mode of ["rust", "native"]) {
  test(
    `${mode} downloads once before offline installation and preserves required packages`,
    { skip: skipReason },
    (t) => {
      const f = fixture(t);
      const result = f.run('install_linux_dependencies "$3" "$4"', [
        mode,
        posix(f.apt),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const commands = f.commands();
      assert.equal(commands.length, 4);
      assert.deepEqual(commands[1], [
        "timeout",
        "--signal=TERM",
        "--kill-after=10s",
        "480s",
      ]);
      const apt = commands.filter(([name]) => name.startsWith("apt:"));
      assert.deepEqual(apt[0], [
        "apt:noninteractive",
        "-o",
        "Acquire::Retries=1",
        "-o",
        "Acquire::http::Timeout=15",
        "-o",
        "Acquire::https::Timeout=15",
        "update",
      ]);
      assert.ok(apt[1].includes("--download-only"));
      assert.ok(apt[2].includes("--no-download"));
      for (const command of apt.slice(1)) {
        assert.ok(command.includes("--no-install-recommends"));
        for (const required of [
          "build-essential",
          "libwebkit2gtk-4.1-dev",
          "libayatana-appindicator3-dev",
          "librsvg2-dev",
          "libssl-dev",
          "libxdo-dev",
          "libatomic1",
          "patchelf",
        ])
          assert.ok(command.includes(required), required);
        for (const required of [
          "xvfb",
          "xauth",
          "dbus-x11",
          "openbox",
          "gdb",
          "libc6-dbg",
          "fonts-noto-cjk",
          "gstreamer1.0-plugins-good",
          "gstreamer1.0-plugins-bad",
          "gstreamer1.0-libav",
        ])
          assert.equal(command.includes(required), mode === "native", required);
      }
      assert.deepEqual(
        apt[1].filter((arg) => arg !== "--download-only"),
        apt[2].filter((arg) => arg !== "--no-download"),
      );
    },
  );
}

for (const [name, env, code] of [
  ["download error", { TEST_DOWNLOAD_FAILURE: "23" }, 23],
  ["download timeout", { TEST_TIMEOUT_FAILURE: "124" }, 124],
]) {
  test(
    `${name} preserves failure without starting dpkg installation`,
    { skip: skipReason },
    (t) => {
      const f = fixture(t);
      const result = f.run(
        'install_linux_dependencies rust "$3"',
        [posix(f.apt)],
        env,
      );
      assert.equal(result.status, code, result.stderr);
      assert.equal(
        f.commands().some((command) => command.includes("--no-download")),
        false,
      );
    },
  );
}

test(
  "unknown mode fails before source edits or package commands",
  { skip: skipReason },
  (t) => {
    const f = fixture(t);
    const result = f.run('install_linux_dependencies wrong "$3"', [
      posix(f.apt),
    ]);
    assert.equal(result.status, 2);
    assert.deepEqual(f.commands(), []);
  },
);
