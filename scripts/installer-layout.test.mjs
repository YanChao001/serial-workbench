import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawnOwned, stopOwned, waitOwned } from "../e2e/process.mjs";
import { fileSha256 } from "./artifact-lib.mjs";
import { loadNodeRuntimeRelease } from "./node-runtime-source.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--interactive"))
  throw new Error("用法: pnpm test:installer --interactive");

function nsisFixture(t) {
  if (!args.includes("--interactive")) {
    t.skip(
      "Native installer executable tests require pnpm test:installer --interactive in an isolated environment",
    );
    return undefined;
  }
  const compiler =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe")
      : "";
  assert.ok(
    compiler && existsSync(compiler),
    "Requires Windows and the NSIS toolchain cached by a Tauri NSIS build",
  );
  const base = realpathSync(tmpdir());
  const fixture = mkdtempSync(join(base, "starter-installer-test-"));
  t.after(() => {
    assert.equal(dirname(fixture), base);
    rmSync(fixture, { recursive: true, force: true });
  });
  return { compiler, fixture };
}

const quote = (value) =>
  value.replaceAll("$", () => "$$").replaceAll('"', () => '$\\"');

function productionMacro(name) {
  const template = readFileSync(
    new URL("../src-tauri/installer/installer.nsi", import.meta.url),
    "utf8",
  );
  const macro = template.match(
    new RegExp(`!macro ${name} [^\\r\\n]+\\r?\\n[\\s\\S]*?!macroend`),
  )?.[0];
  assert.ok(
    macro,
    "Use the same macro as the installer, not a JavaScript reimplementation",
  );
  assert.doesNotMatch(
    template,
    /rR\d/,
    "System uses R0–R9 or r10–r19 for NSIS $R0–$R9",
  );
  return macro;
}

function compileNsis(compiler, fixture, source) {
  const executable = join(fixture, "test.exe");
  const script = join(fixture, "test.nsi");
  writeFileSync(
    script,
    `Unicode true\nSilentInstall silent\nRequestExecutionLevel user\nOutFile "${quote(executable)}"\n${source}`,
  );
  const compiled = spawnSync(compiler, ["/V2", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(
    compiled.status,
    0,
    compiled.error?.message ?? `${compiled.stderr}\n${compiled.stdout}`,
  );
  assert.doesNotMatch(compiled.stdout, /warning \d+:/i);
  return executable;
}

function runNsis(compiler, fixture, source) {
  const executable = compileNsis(compiler, fixture, source);
  // 无安装动作或可见页面；windowsHide 仅用于隐藏控制台。
  const ran = spawnSync(executable, ["/S"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(ran.status, 0, ran.error?.message ?? ran.stderr);
}

test("NSIS preserves artwork proportions and keeps the sidebar mark visible without letterboxing", (t) => {
  const context = nsisFixture(t);
  if (!context) return;
  const { compiler, fixture } = context;
  const macro = productionMacro("SerialWorkbenchFitBitmap");
  const cases = [
    [150, 57, 450, 171],
    [200, 72, 450, 171],
    [240, 57, 450, 171],
    [150, 114, 450, 171],
    [188, 71, 450, 171],
    [300, 114, 450, 171],
    [164, 314, 492, 942],
    [188, 392, 492, 942],
    [492, 942, 492, 942],
    [1, 1, 450, 171],
    [164, 314, 492, 942, "cover"],
    [164, 290, 492, 942, "cover"],
    [218, 362, 492, 942, "cover"],
    [245, 434, 492, 942, "cover"],
    [188, 392, 492, 942, "cover"],
    [218, 458, 492, 942, "cover"],
    [273, 507, 492, 942, "cover"],
    [328, 628, 492, 942, "cover"],
    [492, 942, 492, 942, "cover"],
  ];
  const sidebar = readFileSync(
    new URL("../resources/branding/installer-sidebar.svg", import.meta.url),
    "utf8",
  );
  const mark = sidebar.match(/<image\b[^>]*href="app-icon\.svg"[^>]*>/)?.[0];
  const viewBox = sidebar.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(mark && viewBox);
  const markBounds = Object.fromEntries(
    ["x", "y", "width", "height"].map((name) => [
      name,
      Number(mark.match(new RegExp(`\\b${name}="([\\d.]+)"`))?.[1]),
    ]),
  );
  const results = join(fixture, "geometry.csv");
  runNsis(
    compiler,
    fixture,
    `!include LogicLib.nsh
${macro}
Var ResultFile
Section
  FileOpen $ResultFile "${quote(results)}" w
${cases.map(([width, height, sourceWidth, sourceHeight, mode = "contain"]) => `  StrCpy $0 101\n  StrCpy $2 ${width}\n  StrCpy $3 ${height}\n  StrCpy $5 ${sourceWidth}\n  StrCpy $6 ${sourceHeight}\n  !insertmacro SerialWorkbenchFitBitmap $2 $3 $5 $6 ${mode}\n  FileWrite $ResultFile "$R7,$R8,$R9,$4,$0$\\r$\\n"`).join("\n")}
  FileClose $ResultFile
SectionEnd
`,
  );
  const text = readFileSync(results, "utf8");
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map(Number));
  assert.equal(rows.length, cases.length, JSON.stringify(text));
  rows.forEach(([width, height, x, y, control], index) => {
    assert.equal(control, 101, "preserves the caller's window handle register");
    const [boxWidth, boxHeight, sourceWidth, sourceHeight, mode = "contain"] =
      cases[index];
    const covers = mode === "cover";
    assert.ok(
      width > 0 &&
        height > 0 &&
        (covers
          ? width >= boxWidth && height >= boxHeight
          : width <= boxWidth && height <= boxHeight),
      `fits case ${index}`,
    );
    assert.ok(
      Math.abs(width * sourceHeight - height * sourceWidth) <=
        Math.max(sourceWidth, sourceHeight),
      `uniform scale within one pixel for case ${index}: ${JSON.stringify(rows[index])}`,
    );
    assert.ok(
      (covers ? x <= 0 && y <= 0 : x >= 0 && y >= 0) &&
        Math.abs(boxWidth - width - 2 * x) <= 1 &&
        Math.abs(boxHeight - height - 2 * y) <= 1,
      `centered case ${index}`,
    );
    assert.ok(
      width === boxWidth || height === boxHeight,
      `uses available space case ${index}`,
    );
    if (covers) {
      assert.ok(x + width >= boxWidth && y + height >= boxHeight);
      const svgWidth = Number(viewBox[1]);
      const svgHeight = Number(viewBox[2]);
      assert.ok(
        x + (width * markBounds.x) / svgWidth >= 0 &&
          y + (height * markBounds.y) / svgHeight >= 0 &&
          x + (width * (markBounds.x + markBounds.width)) / svgWidth <=
            boxWidth &&
          y + (height * (markBounds.y + markBounds.height)) / svgHeight <=
            boxHeight,
        `crops decoration without clipping the shared mark in case ${index}`,
      );
    }
  });
});

test("NSIS artwork stays opaque when themed static controls paint and image loading fails safely", (t) => {
  const context = nsisFixture(t);
  if (!context) return;
  const { compiler, fixture } = context;
  const cases = [
    [200, 72, "header.bmp", "contain"],
    [300, 114, "header.bmp", "contain"],
    [188, 392, "sidebar.bmp", "cover"],
    [218, 362, "sidebar.bmp", "cover"],
    [245, 434, "sidebar.bmp", "cover"],
    [218, 458, "sidebar.bmp", "cover"],
    [273, 507, "sidebar.bmp", "cover"],
    [328, 628, "sidebar.bmp", "cover"],
  ];
  const results = join(fixture, "pixels.csv");
  // HWND_MESSAGE 的子控件没有桌面表面；不调用 ShowWindow、激活或抢占焦点。
  // 使用与 MUI 相同的 v6 主题和 SS_BITMAP 控件，通过 WM_PRINTCLIENT 检查真实绘制。
  runNsis(
    compiler,
    fixture,
    `XPStyle on
ManifestDPIAware true
!include LogicLib.nsh
!include WinMessages.nsh
!include nsDialogs.nsh
${productionMacro("SerialWorkbenchFitBitmap")}
${productionMacro("SerialWorkbenchSetSharpBitmap")}
Var ResultFile
Var Control
Var Image
Var ScreenDC
Var SourceDC
Var PaintDC
Var PaintBitmap
Var SourcePrevious
Var PaintPrevious
Var Assigned
Section
  FileOpen $ResultFile "${quote(results)}" w
  System::Call 'USER32::GetDC(p0)p.s'
  Pop $ScreenDC
${cases
  .map(([width, height, name, mode], index) => {
    const path = quote(
      fileURLToPath(new URL(`../src-tauri/installer/${name}`, import.meta.url)),
    );
    return `  System::Call 'USER32::CreateWindowEx(i0,t "STATIC",t "",i0x5000010E,i0,i0,i${width},i${height},p-3,p0,p0,p0)p.s'
  Pop $Control
  \${NSD_SetStretchedImage} $Control "${path}" $Image
  !insertmacro SerialWorkbenchSetSharpBitmap $Control "${path}" $Image ${mode}
  SendMessage $Control \${STM_GETIMAGE} \${IMAGE_BITMAP} 0 $Assigned
  System::Call '*(i0,i0,i0,i0,i0,p0)p.r0'
  System::Call 'GDI32::GetObject(p $Assigned,i24,pr0)i.r1'
  System::Call '*$0(i,i.r2,i.r3,i,&i2.r4,&i2.r5)'
  System::Free $0
  FileWrite $ResultFile "meta,${index},$Control,$Image,$Assigned,$1,$2,$3,$5$\\r$\\n"
  System::Call 'GDI32::CreateCompatibleDC(p $ScreenDC)p.s'
  Pop $SourceDC
  System::Call 'GDI32::CreateCompatibleDC(p $ScreenDC)p.s'
  Pop $PaintDC
  System::Call 'GDI32::CreateCompatibleBitmap(p $ScreenDC,i${width},i${height})p.s'
  Pop $PaintBitmap
  System::Call 'GDI32::SelectObject(p $PaintDC,p $PaintBitmap)p.s'
  Pop $PaintPrevious
  SendMessage $Control 0x318 $PaintDC 4
  System::Call 'GDI32::SelectObject(p $SourceDC,p $Assigned)p.s'
  Pop $SourcePrevious
${Array.from({ length: 9 }, (_, y) =>
  Array.from({ length: 9 }, (_, x) => {
    const px = Math.floor(((x + 1) * width) / 10);
    const py = Math.floor(((y + 1) * height) / 10);
    return `  System::Call 'GDI32::GetPixel(p $SourceDC,i${px},i${py})i.r0'
  System::Call 'GDI32::GetPixel(p $PaintDC,i${px},i${py})i.r1'
  FileWrite $ResultFile "pixel,${index},$0,$1$\\r$\\n"`;
  }).join("\n"),
).join("\n")}
  System::Call 'GDI32::GetPixel(p $SourceDC,i${Math.floor(width / 2)},i0)i.r0'
  System::Call 'GDI32::GetPixel(p $SourceDC,i${Math.floor(width / 2)},i${height - 1})i.r1'
  FileWrite $ResultFile "edge,${index},$0,$1$\\r$\\n"
  !insertmacro SerialWorkbenchSetSharpBitmap $Control "${quote(join(fixture, "missing.bmp"))}" $Image ${mode}
  SendMessage $Control \${STM_GETIMAGE} \${IMAGE_BITMAP} 0 $0
  FileWrite $ResultFile "fallback,${index},$Image,$0$\\r$\\n"
  System::Call 'GDI32::SelectObject(p $SourceDC,p $SourcePrevious)'
  System::Call 'GDI32::SelectObject(p $PaintDC,p $PaintPrevious)'
  System::Call 'GDI32::DeleteDC(p $SourceDC)'
  System::Call 'GDI32::DeleteDC(p $PaintDC)'
  System::Call 'GDI32::DeleteObject(p $PaintBitmap)'
  SendMessage $Control \${STM_SETIMAGE} \${IMAGE_BITMAP} 0
  System::Call 'GDI32::DeleteObject(p $Image)'
  System::Call 'USER32::DestroyWindow(p $Control)'`;
  })
  .join("\n")}
  System::Call 'USER32::ReleaseDC(p0,p $ScreenDC)'
  FileClose $ResultFile
SectionEnd`,
  );
  const rows = readFileSync(results, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  cases.forEach(([width, height, , mode], index) => {
    const selected = rows.filter((row) => Number(row[1]) === index);
    const [, , control, owned, assigned, size, bmpWidth, bmpHeight, bits] =
      selected.find((row) => row[0] === "meta");
    assert.notEqual(Number(control), 0);
    assert.notEqual(Number(owned), 0);
    assert.equal(
      assigned,
      owned,
      "themed controls must not create a transparent alpha copy",
    );
    assert.equal(Number(size), 24);
    assert.deepEqual(
      [Number(bmpWidth), Number(bmpHeight), Number(bits)],
      [width, height, 24],
    );
    const pixels = selected.filter((row) => row[0] === "pixel");
    assert.equal(pixels.length, 81);
    assert.ok(
      pixels.filter((row) => Number(row[2]) !== 0xffffff).length > 12,
      "actual artwork is present",
    );
    pixels.forEach(([, , bitmap, painted]) => {
      assert.notEqual(Number(bitmap), -1);
      assert.equal(
        painted,
        bitmap,
        `case ${index} paints opaque artwork, including the white background`,
      );
    });
    if (mode === "cover") {
      const edges = selected
        .find((row) => row[0] === "edge")
        .slice(2)
        .map(Number);
      assert.ok(
        edges.every((color) => color !== -1 && color !== 0xffffff),
        `sidebar reaches both vertical edges without white bands in case ${index}`,
      );
    }
    assert.deepEqual(selected.find((row) => row[0] === "fallback").slice(2), [
      owned,
      owned,
    ]);
  });
});

test("NSIS stages the adjacent payload without reaching ordinary install effects", () => {
  const installer = readFileSync(
    new URL("../src-tauri/installer/installer.nsi", import.meta.url),
    "utf8",
  );
  const init = installer.match(/Function \.onInit\b[\s\S]*?FunctionEnd/)?.[0];
  const initialCheck = installer.match(
    /Function SerialWorkbenchStageInit\b[\s\S]*?FunctionEnd/,
  )?.[0];
  const webview = installer.match(
    /^Section WebView2\b[\s\S]*?SectionEnd/m,
  )?.[0];
  const install = installer.match(/^Section Install\b[\s\S]*?SectionEnd/m)?.[0];
  const postInstall = installer.match(
    /Function \.onInstSuccess\b[\s\S]*?FunctionEnd/,
  )?.[0];
  assert.ok(init && initialCheck && webview && install && postInstall);

  assert.match(
    init,
    /StrCmpS \$1 "\/S \/SWB-STAGE"[\s\S]*?Call SerialWorkbenchStageInit\s+Return[\s\S]*?MUI_LANGDLL_DISPLAY/,
  );
  assert.match(
    initialCheck,
    /\$INSTDIR != "\$\{PLACEHOLDER_INSTALL_DIR\}"[\s\S]*?CreateFileW\(w "\$EXEDIR", i 0x81, i 3,[\s\S]*?GetFinalPathNameByHandleW[\s\S]*?StrCpy \$INSTDIR \$3[\s\S]*?FindFirst/,
  );
  assert.match(
    webview,
    /^Section WebView2\s+\$\{If\} \$StageOnly = 1\s+Goto webview2_section_end[\s\S]*?ReadRegStr[\s\S]*?webview2_section_end:\s+SectionEnd$/,
  );
  assert.match(
    install,
    /\$\{If\} \$StageOnly <> 1[\s\S]*?NSIS_HOOK_PREINSTALL[\s\S]*?CheckIfAppIsRunning[\s\S]*?\$\{EndIf\}[\s\S]*?File "\$\{MAINBINARYSRCPATH\}"[\s\S]*?\{\{#each binaries\}\}[\s\S]*?\$\{If\} \$StageOnly = 1[\s\S]*?WriteUninstaller[\s\S]*?Goto install_section_end[\s\S]*?!insertmacro APP_ASSOCIATE[\s\S]*?WriteRegStr[\s\S]*?CreateOrUpdateStartMenuShortcut[\s\S]*?install_section_end:\s+SectionEnd$/,
  );
  assert.match(
    postInstall,
    /^Function \.onInstSuccess\s+\$\{If\} \$StageOnly = 1\s+Return[\s\S]*?RunAsUser/,
  );
});

test("NSIS staging accepts a fresh operation directory and refuses populated, misnamed, or redirected directories", (t) => {
  const context = nsisFixture(t);
  if (!context) return;
  const { compiler, fixture } = context;
  const installer = readFileSync(
    new URL("../src-tauri/installer/installer.nsi", import.meta.url),
    "utf8",
  );
  const functions = installer.match(
    /Function SerialWorkbenchRejectStage\b[\s\S]*?Function SerialWorkbenchStageInit\b[\s\S]*?FunctionEnd/,
  )?.[0];
  const stageBranch = installer.match(
    /^Function \.onInit\b[\s\S]*?Call SerialWorkbenchStageInit\s+Return\s+\$\{EndIf\}/m,
  )?.[0];
  assert.ok(functions && stageBranch);
  const rejection = join(fixture, "stage-rejection.txt");
  const tracedFunctions = functions.replace(
    "  SetErrorLevel $StageRejectCode",
    `  FileOpen $5 "${quote(rejection)}" w
  FileWrite $5 "exedir=$EXEDIR length=$1 drive=$2 actual=$0 requested=$3 win32=$4"
  FileClose $5
  SetErrorLevel $StageRejectCode`,
  );
  const payload = "signed fixture component\n";
  const source = join(fixture, "component.txt");
  writeFileSync(source, payload);
  const executable = compileNsis(
    compiler,
    fixture,
    `!include LogicLib.nsh
!include FileFunc.nsh
!include StrFunc.nsh
\${StrCase}
!define INSTALLMODE "currentUser"
!define PLACEHOLDER_INSTALL_DIR "$TEMP\\swb-stage-placeholder"
InstallDir "\${PLACEHOLDER_INSTALL_DIR}"
Var StageOnly
Var StageDirHandle
Var StageRejectCode
${tracedFunctions}
${stageBranch}
  StrCpy $StageRejectCode 2
  Call SerialWorkbenchRejectStage
FunctionEnd
Section
  \${If} $StageOnly <> 1
    StrCpy $StageRejectCode 2
    Call SerialWorkbenchRejectStage
  \${EndIf}
  SetOutPath "$INSTDIR"
  File "/oname=component.txt" "${quote(source)}"
SectionEnd
`,
  );
  const physical = join(fixture, "physical-parent");
  const aliased = join(fixture, "aliased-parent");
  mkdirSync(physical);
  symlinkSync(physical, aliased, "junction");
  for (const scenario of ["fresh", "populated", "misnamed", "parent-alias"]) {
    const directory = join(
      scenario === "parent-alias" ? aliased : fixture,
      scenario === "misnamed"
        ? "ordinary-directory"
        : `.swb-stage-${randomUUID()}`,
    );
    mkdirSync(directory);
    const copy = join(directory, "installer.exe");
    copyFileSync(executable, copy);
    if (scenario === "populated")
      writeFileSync(join(directory, "keep.txt"), "existing");
    const ran = spawnSync(copy, ["/S", "/SWB-STAGE"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(
      ran.status,
      { fresh: 0, populated: 8, misnamed: 4, "parent-alias": 10 }[scenario],
      `${scenario} failed (status ${ran.status}): ${ran.error?.message ?? ran.stderr}${existsSync(rejection) ? readFileSync(rejection, "utf8") : ""}`,
    );
    const expected = ["installer.exe"];
    if (scenario === "fresh") {
      expected.push("component.txt");
      assert.equal(
        readFileSync(join(directory, "component.txt"), "utf8"),
        payload,
      );
    }
    if (scenario === "populated") {
      expected.push("keep.txt");
      assert.equal(
        readFileSync(join(directory, "keep.txt"), "utf8"),
        "existing",
      );
    }
    assert.deepEqual(readdirSync(directory).sort(), expected.sort(), scenario);
  }
});

async function waitForInstalledHost(owned, profile) {
  const discovery = join(profile, "host-v0", "discovery.json");
  const deadline = Date.now() + 20_000;
  while (!owned.state.done && Date.now() < deadline) {
    if (existsSync(discovery)) {
      const current = JSON.parse(readFileSync(discovery, "utf8"));
      if (current.pid === owned.child.pid) return current;
    }
    await delay(50);
  }
  throw new Error(
    "The test Host did not publish discovery for the expected process",
  );
}

async function verifyInstalledSuiteSwitch(
  fixture,
  verifier,
  previous,
  candidate,
  installation,
) {
  const profile = join(fixture, "switch-profile");
  mkdirSync(profile);
  const marker = join(profile, "test-user-content.txt");
  writeFileSync(marker, "preserved profile data");
  const host = () => join(installation, "serial-workbench-host.exe");
  const originalDesktop = fileSha256(
    join(installation, "serial-workbench.exe"),
  );
  const nextDesktop = fileSha256(
    join(candidate.staged, "serial-workbench.exe"),
  );
  assert.notEqual(previous.digest, candidate.digest);
  assert.notEqual(originalDesktop, nextDesktop);
  const requestPath = join(fixture, "switch.json");
  const switchSuite = (suites, operation = candidate.operation) => {
    writeFileSync(
      requestPath,
      JSON.stringify({
        profile,
        activeInstall: installation,
        operation,
        suites,
      }),
    );
    return spawnSync(verifier, ["--switch-windows-nsis", requestPath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 90_000,
    });
  };
  const expectCommitted = (result) => {
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      operation: candidate.operation,
      state: "committed",
    });
  };

  const old = spawnOwned(host(), ["--profile", profile], {
    logPath: join(fixture, "old-host.log"),
  });
  let replacement;
  try {
    const before = await waitForInstalledHost(old, profile);
    const invalid = switchSuite({
      previous: previous.digest,
      candidate: "0".repeat(64),
    });
    assert.equal(invalid.status, 1, invalid.error?.message ?? invalid.stderr);
    assert.match(invalid.stderr, /suite digests differ/);
    assert.equal(old.child.exitCode, null);
    assert.ok(process.kill(before.pid, 0));
    assert.equal(
      fileSha256(join(installation, "serial-workbench.exe")),
      originalDesktop,
    );

    expectCommitted(
      switchSuite({ previous: previous.digest, candidate: candidate.digest }),
    );
    await waitOwned(old, AbortSignal.timeout(10_000));
    expectCommitted(switchSuite());
    const pending = switchSuite(undefined, null);
    assert.equal(pending.status, 0, pending.error?.message ?? pending.stderr);
    assert.deepEqual(JSON.parse(pending.stdout), {
      operation: null,
      state: "not_started",
    });
    const backup = join(
      dirname(installation),
      `.swb-old-${candidate.operation}`,
    );
    assert.equal(
      fileSha256(join(backup, "serial-workbench.exe")),
      originalDesktop,
    );
    assert.equal(
      fileSha256(join(installation, "serial-workbench.exe")),
      nextDesktop,
    );
    assert.ok(!existsSync(candidate.staged));

    replacement = spawnOwned(host(), ["--profile", profile], {
      logPath: join(fixture, "new-host.log"),
    });
    const after = await waitForInstalledHost(replacement, profile);
    assert.equal(after.hostId, before.hostId);
    assert.ok(BigInt(after.instanceEpoch) > BigInt(before.instanceEpoch));
    assert.equal(readFileSync(marker, "utf8"), "preserved profile data");
    const stop = spawnSync(
      join(installation, "serial-workbench-cli.exe"),
      ["--profile", profile, "host", "stop", "--json"],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(stop.status, 0, stop.error?.message ?? stop.stderr);
    await waitOwned(replacement, AbortSignal.timeout(10_000));
    return {
      previousVersion: previous.version,
      candidateVersion: candidate.version,
      operation: candidate.operation,
      previousDigest: previous.digest,
      candidateDigest: candidate.digest,
      previousEpoch: before.instanceEpoch,
      candidateEpoch: after.instanceEpoch,
      identityPreserved: true,
      profileDataPreserved: true,
      badDigestLeftHostRunning: true,
    };
  } finally {
    await stopOwned(replacement);
    await stopOwned(old);
  }
}

test("the verified NSIS stages pinned components without registering an installation", async (t) => {
  const input = process.env.SWB_TEST_NSIS_STAGE_INSTALLER;
  if (!input) {
    t.skip("The isolated NSIS stage suite supplies this build's installer");
    return;
  }
  const context = nsisFixture(t);
  if (!context) return;
  const verifier = process.env.SWB_TEST_NSIS_STAGE_VERIFIER;
  assert.ok(verifier, "The isolated NSIS stage suite supplies its verifier");
  const packagePath = realpathSync(input);
  const manifest = JSON.parse(
    readFileSync(join(dirname(packagePath), "../components.json"), "utf8"),
  );
  assert.equal(manifest.target, "x86_64-pc-windows-msvc");
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const root = dirname(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  );
  const node = loadNodeRuntimeRelease(root).targets.find(
    ({ target }) => target === manifest.target,
  );
  assert.ok(node);

  const registryKeys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${config.productName}`,
    `HKCU\\Software\\${config.bundle.publisher}\\${config.productName}`,
    ...config.plugins["deep-link"].desktop.schemes.map(
      (scheme) => `HKCU\\Software\\Classes\\${scheme}`,
    ),
  ];
  const registry = () =>
    registryKeys.flatMap((key) =>
      ["/reg:32", "/reg:64"].map((view) => {
        const result = spawnSync("reg.exe", ["query", key, "/s", view], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
        assert.ok(
          result.status === 0 || result.status === 1,
          "Registry snapshot failed",
        );
        return { status: result.status, stdout: result.stdout };
      }),
    );
  const before = registry();
  const fixture = context.fixture;
  const version =
    process.env.SWB_TEST_NSIS_STAGE_VERSION ??
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const key = join(fixture, "fixture-updater.key");
  const password = "temporary-stage-fixture";
  const sign = (...args) => {
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "signer", ...args],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  sign("generate", "--ci", "--write-keys", key, "--password", password);
  const publicKey = readFileSync(`${key}.pub`, "utf8");
  const signedCopy = (name, input = packagePath, releaseVersion = version) => {
    const copy = join(fixture, name);
    copyFileSync(input, copy);
    sign(
      "sign",
      "--private-key-path",
      key,
      "--password",
      password,
      "--app-version",
      releaseVersion,
      copy,
    );
    return `${copy}.sig`;
  };
  const legacySignature = signedCopy("installer.exe");
  const stageSignature = signedCopy("serial-workbench-nsis-stage-v1.exe");
  const inputFile = join(fixture, "stage.json");
  const request = {
    activeInstall: join(fixture, "Serial Workbench"),
    artifact: packagePath,
    publicKey,
    version,
    signature: stageSignature,
  };
  mkdirSync(request.activeInstall);
  const installed = join(request.activeInstall, "existing-component");
  writeFileSync(installed, "original installation");
  const stageUpdate = (overrides = {}) => {
    writeFileSync(inputFile, JSON.stringify({ ...request, ...overrides }));
    return spawnSync(verifier, ["--stage-windows-nsis", inputFile], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 150_000,
    });
  };
  const legacy = stageUpdate({ signature: legacySignature });
  assert.equal(legacy.status, 1, legacy.error?.message ?? legacy.stderr);
  assert.match(
    legacy.stderr,
    /does not declare the current-user NSIS stage protocol/,
  );
  const wrongVersion = stageUpdate({ version: "0.0.0" });
  assert.equal(
    wrongVersion.status,
    1,
    wrongVersion.error?.message ?? wrongVersion.stderr,
  );
  assert.match(wrongVersion.stderr, /signature version does not match/);
  const tampered = join(fixture, "tampered.exe");
  writeFileSync(tampered, "different artifact bytes");
  const mismatched = stageUpdate({ artifact: tampered });
  assert.equal(
    mismatched.status,
    1,
    mismatched.error?.message ?? mismatched.stderr,
  );
  assert.deepEqual(
    readdirSync(fixture).filter((name) => name.startsWith(".swb-stage-")),
    [],
  );

  const result = stageUpdate();
  const installerSha256 = fileSha256(packagePath);
  assert.deepEqual(
    registry(),
    before,
    "Staging changed installation registry keys",
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const {
    staged: stage,
    digest,
    operation,
    version: stagedVersion,
  } = JSON.parse(result.stdout);
  assert.match(
    operation,
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
  );
  assert.equal(
    realpathSync.native(stage),
    realpathSync.native(join(fixture, `.swb-stage-${operation}`)),
  );
  assert.match(digest, /^[\da-f]{64}$/);
  assert.equal(stagedVersion, version);
  assert.ok(!existsSync(join(stage, "serial-workbench-nsis-stage-v1.exe")));
  assert.deepEqual(readdirSync(request.activeInstall), ["existing-component"]);
  assert.equal(readFileSync(installed, "utf8"), "original installation");
  const components = Object.fromEntries(
    manifest.components.map(({ path, sha256 }) => {
      assert.match(path, /^serial-workbench-(?:host|cli|mcp)\.exe$/);
      assert.equal(fileSha256(join(stage, path)), sha256);
      return [path, sha256];
    }),
  );
  assert.equal(Object.keys(components).length, 3);
  const nodeSha256 = fileSha256(join(stage, node.executable.resourcePath));
  assert.equal(nodeSha256, node.executable.sha256);
  const desktopSha256 = fileSha256(join(stage, "serial-workbench.exe"));
  const uninstallerSha256 = fileSha256(join(stage, "uninstall.exe"));
  t.diagnostic(
    JSON.stringify({
      installerSha256,
      operation,
      suiteDigest: digest,
      stageVersion: stagedVersion,
      legacySignatureRejected: true,
      wrongVersionRejected: true,
      tamperedArtifactRejected: true,
      components,
      nodeSha256,
      desktopSha256,
      uninstallerSha256,
      registryUnchanged: true,
    }),
  );
  const next = process.env.SWB_TEST_NSIS_NEXT_INSTALLER;
  if (next) {
    const nextVersion = process.env.SWB_TEST_NSIS_NEXT_VERSION;
    assert.ok(nextVersion && nextVersion !== version);
    const installation = join(fixture, "Installed Suite");
    renameSync(stage, installation);
    const nextDir = join(fixture, "next");
    mkdirSync(nextDir);
    const nextSignature = signedCopy(
      join("next", "serial-workbench-nsis-stage-v1.exe"),
      next,
      nextVersion,
    );
    const nextResult = stageUpdate({
      activeInstall: installation,
      artifact: next,
      version: nextVersion,
      signature: nextSignature,
    });
    assert.equal(
      nextResult.status,
      0,
      nextResult.error?.message ?? nextResult.stderr,
    );
    t.diagnostic(
      JSON.stringify(
        await verifyInstalledSuiteSwitch(
          fixture,
          verifier,
          { staged: stage, digest, operation, version },
          JSON.parse(nextResult.stdout),
          installation,
        ),
      ),
    );
    assert.deepEqual(registry(), before);
  }
});
