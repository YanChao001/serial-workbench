param(
  [Parameter(Mandatory)]
  [string]$Target,
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$PreviousCommit
)

$ErrorActionPreference = 'Stop'
if ($env:RUNNER_OS -ne 'Windows' -or !$env:RUNNER_TEMP -or $Target -ne 'x86_64-pc-windows-msvc') {
    throw 'The desktop update scenario requires an isolated Windows x64 runner.'
}

$fixture = Join-Path $env:RUNNER_TEMP ('swb-desktop-update-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$evidence = [IO.Path]::GetFullPath('artifacts/windows-desktop-update')
New-Item -ItemType Directory -Path $evidence | Out-Null
$env:SWB_TEST_UPDATE_DIRECTORY = $fixture
$env:SWB_TEST_UPDATE_EVIDENCE = $evidence
$env:SWB_TEST_UPDATE_SIGNING_KEY = Join-Path $fixture 'update.key'
$env:SWB_TEST_UPDATE_PASSWORD = [Guid]::NewGuid().ToString('N')
$env:SWB_TEST_UPDATE_PFX = Join-Path $fixture 'server.pfx'
$phaseLog = Join-Path $evidence 'phases.log'

function Write-Phase([string]$Name) {
    $line = '{0:o} {1}' -f [DateTime]::UtcNow,$Name
    Add-Content -LiteralPath $phaseLog -Value $line -Encoding UTF8
    Write-Host $line
}

function Initialize-LoopbackCertificate {
    $job = Start-Job -PSVersion 5.1 -ArgumentList $fixture,$phaseLog,$env:SWB_TEST_UPDATE_PASSWORD,$env:SWB_TEST_UPDATE_PFX -ScriptBlock {
        param($Directory,$PhaseLog,$Password,$Pfx)
        $ErrorActionPreference = 'Stop'
        function Mark([string]$Name) {
            Add-Content -LiteralPath $PhaseLog -Value ('{0:o} {1}' -f [DateTime]::UtcNow,$Name) -Encoding UTF8
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'The isolated runner requires access to its local-machine certificate store.'
        }
        $expires = (Get-Date).AddHours(12)
        Mark 'creating loopback root'
        $authority = New-SelfSignedCertificate -Type Custom -Subject "CN=Serial Workbench update fixture $([Guid]::NewGuid())" `
            -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage CertSign,CRLSign,DigitalSignature `
            -TextExtension '2.5.29.19={critical}{text}ca=1&pathlength=0' -NotAfter $expires
        Set-Content -LiteralPath (Join-Path $Directory 'root.thumbprint') -Value $authority.Thumbprint -Encoding Ascii
        Mark 'creating localhost leaf'
        $server = New-SelfSignedCertificate -Type Custom -DnsName localhost -Signer $authority `
            -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage DigitalSignature,KeyEncipherment `
            -KeyExportPolicy Exportable -TextExtension '2.5.29.37={text}1.3.6.1.5.5.7.3.1' -NotAfter $expires
        Set-Content -LiteralPath (Join-Path $Directory 'leaf.thumbprint') -Value $server.Thumbprint -Encoding Ascii

        Mark 'trusting public loopback root'
        $root = [Security.Cryptography.X509Certificates.X509Certificate2]::new($authority.RawData)
        $store = [Security.Cryptography.X509Certificates.X509Store]::new(
            [Security.Cryptography.X509Certificates.StoreName]::Root,
            [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
        )
        try {
            $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $store.Add($root)
        }
        finally {
            $store.Dispose()
            $root.Dispose()
        }

        Mark 'exporting loopback server fixture'
        $secret = ConvertTo-SecureString $Password -AsPlainText -Force
        Export-PfxCertificate -Cert $server -FilePath $Pfx -Password $secret | Out-Null
    }
    try {
        if (!(Wait-Job -Job $job -Timeout 90)) {
            throw 'Certificate preparation exceeded 90 seconds. See phases.log.'
        }
        Receive-Job -Job $job
        if ($job.State -ne 'Completed') { throw "Certificate job ended as $($job.State)." }
    }
    finally {
        if ($job.State -eq 'Running') { Stop-Job -Job $job }
        Remove-Job -Job $job
    }
}

function Remove-FixtureCertificate([string]$File, [string[]]$Stores) {
    $path = Join-Path $fixture $File
    if (!(Test-Path -LiteralPath $path)) { return }
    $thumbprint = [IO.File]::ReadAllText($path).Trim()
    if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Invalid fixture certificate thumbprint.' }
    foreach ($store in $Stores) {
        $certificate = "$store\$thumbprint"
        if (Test-Path -LiteralPath $certificate) { Remove-Item -LiteralPath $certificate }
    }
}

function Invoke-CheckedPnpm([string[]]$Arguments) {
    pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm exited with $LASTEXITCODE" }
}

function Find-NsisPackage([string]$Version) {
    $bundles = @(Get-ChildItem -LiteralPath "artifacts/$Version/$Target/installers/nsis" -Filter '*-setup.exe' -File)
    if ($bundles.Count -ne 1) { throw "Expected one NSIS package for $Version." }
    return $bundles[0].FullName
}

function Set-UpdateFixtureConfig([string]$Path, [string]$PublicKey) {
    $config = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    $config.updates.endpoint = 'https://localhost/latest.json'
    $config.updates.publicKey = $PublicKey
    [IO.File]::WriteAllText($Path, ($config | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}

function Read-FixtureProtocol([string]$Root) {
    $path = Join-Path $Root 'packages/contracts/src/generated/schemas.json'
    return (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json).protocolVersion
}

$candidateRoot = (Get-Location).Path
$candidateCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $candidateCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Cannot identify the candidate source.'
}
$oldRoot = $candidateRoot
if ($PreviousCommit) {
    git fetch --no-tags --depth=1 origin $PreviousCommit
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the pinned previous source.' }
    $oldRoot = Join-Path $fixture 'previous-source'
    git worktree add --quiet --detach $oldRoot $PreviousCommit
    if ($LASTEXITCODE -ne 0 -or (git -C $oldRoot rev-parse HEAD) -ne $PreviousCommit) {
        throw 'Could not check out the pinned previous source.'
    }
}
$configPath = (Resolve-Path -LiteralPath 'app.config.json').Path
$originalConfig = [IO.File]::ReadAllBytes($configPath)
$candidateVersion = (Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json).version
$originalVersion = (Get-Content -Raw -LiteralPath (Join-Path $oldRoot 'package.json') | ConvertFrom-Json).version
$oldVersion = [version](($originalVersion -split '[-+]')[0])
$newVersion = [version](($candidateVersion -split '[-+]')[0])
$env:SWB_TEST_UPDATE_OLD_VERSION = $originalVersion
$env:SWB_TEST_UPDATE_NEW_VERSION = if ($newVersion -gt $oldVersion) {
    $candidateVersion
} else {
    '{0}.{1}.{2}' -f $oldVersion.Major,$oldVersion.Minor,($oldVersion.Build + 1)
}
$env:SWB_TEST_UPDATE_OLD_COMMIT = if ($PreviousCommit) { $PreviousCommit } else { $candidateCommit }
$env:SWB_TEST_UPDATE_NEW_COMMIT = $candidateCommit
$env:SWB_TEST_UPDATE_OLD_PROTOCOL = Read-FixtureProtocol $oldRoot
$env:SWB_TEST_UPDATE_NEW_PROTOCOL = Read-FixtureProtocol $candidateRoot
if ($PreviousCommit -and ($env:SWB_TEST_UPDATE_OLD_PROTOCOL -ne '0.1' -or $env:SWB_TEST_UPDATE_NEW_PROTOCOL -ne '1.0')) {
    throw 'The cross-source scenario requires the 0.1 to 1.0 wire transition.'
}
try {
    Invoke-CheckedPnpm @('exec','tauri','signer','generate','--ci','--write-keys',$env:SWB_TEST_UPDATE_SIGNING_KEY,'--password',$env:SWB_TEST_UPDATE_PASSWORD) | Out-Null
    $publicKey = [IO.File]::ReadAllText($env:SWB_TEST_UPDATE_SIGNING_KEY + '.pub').Trim()
    Set-UpdateFixtureConfig $configPath $publicKey

    $build = @('app:build','--target',$Target,'--bundles','nsis','--optimize','speed','--ci','--no-sign')
    Push-Location -LiteralPath $oldRoot
    try {
        if ($PreviousCommit) {
            Invoke-CheckedPnpm @('install','--frozen-lockfile')
            Set-UpdateFixtureConfig (Join-Path $oldRoot 'app.config.json') $publicKey
        }
        Write-Phase 'building the previous suite'
        Invoke-CheckedPnpm $build
        $env:SWB_TEST_UPDATE_OLD_INSTALLER = Find-NsisPackage $originalVersion
    } finally {
        Pop-Location
    }
    if ($candidateVersion -ne $env:SWB_TEST_UPDATE_NEW_VERSION) {
        Invoke-CheckedPnpm @('version:set',$env:SWB_TEST_UPDATE_NEW_VERSION)
    }
    Write-Phase 'building the candidate suite'
    Invoke-CheckedPnpm $build
    $env:SWB_TEST_UPDATE_NEW_INSTALLER = Find-NsisPackage $env:SWB_TEST_UPDATE_NEW_VERSION
    cargo build --locked -p serial-workbench --release --features bindings --bin verify-updater --target $Target
    if ($LASTEXITCODE -ne 0) { throw "Coordinator verifier build exited with $LASTEXITCODE" }
    $env:SWB_TEST_UPDATE_VERIFIER = (Resolve-Path -LiteralPath "src-tauri/target/$Target/release/verify-updater.exe").Path

    Write-Phase 'built both suites and their verifier'
    Initialize-LoopbackCertificate
    Write-Phase 'starting desktop update scenario'
    $scenario = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'scripts/ci-windows-desktop-update.mjs' `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $evidence 'scenario.log') `
        -RedirectStandardError (Join-Path $evidence 'scenario-error.log')
    if (!$scenario.WaitForExit(720000)) {
        if (!$scenario.HasExited) { taskkill.exe /PID $scenario.Id /T /F | Out-Null }
        $fixtureExecutable = Join-Path $fixture 'installed-suite\serial-workbench.exe'
        Get-Process -Name 'serial-workbench' -ErrorAction SilentlyContinue |
            Where-Object Path -eq $fixtureExecutable | Stop-Process
        throw 'Desktop update scenario exceeded 12 minutes. See phases.log and scenario-error.log.'
    }
    if ($scenario.ExitCode -ne 0) { throw "Desktop update scenario exited with $($scenario.ExitCode)." }
    Write-Phase 'desktop update scenario complete'
}
finally {
    try {
        Remove-FixtureCertificate 'root.thumbprint' @('Cert:\LocalMachine\Root','Cert:\CurrentUser\My')
    }
    finally {
        try {
            Remove-FixtureCertificate 'leaf.thumbprint' @('Cert:\CurrentUser\My')
        }
        finally {
            [IO.File]::WriteAllBytes($configPath, $originalConfig)
        }
    }
}
