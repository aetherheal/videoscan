#Requires -Version 5.1

<#
.SYNOPSIS
Copies DJI drone footage to one or more independently checked backup roots.

.DESCRIPTION
Recursively finds full-resolution DJI .MP4 files below SourceRoot, derives each
recording date from a name such as DJI_20260822095208_0037_D.MP4, and copies the
file into a yyyy-MM-dd subfolder below every destination root.

Before copying, the script indexes each destination recursively by filename. A
file is skipped only at destinations where that filename already exists; other
destinations are still handled independently. DJI .LRF proxy files are never
copied.

Every .MP4 is backed up, including ones whose names are not in DJI format
(legacy Phantom/Osmo names, renamed or split clips). Those are dated from their
LastWriteTime instead and reported via warnings and the summary's
UnrecognizedNamesDatedByMtime count — footage is never dropped merely because
its name is unfamiliar. Hidden and system files are included in the scan.

Two conditions are non-fatal but reported: a filename appearing more than once
below SourceRoot is ambiguous for a filename-keyed backup, so those specific
names are skipped (see DuplicateNamesSkipped) while everything else still
copies; and a destination that cannot be fully indexed only risks a redundant
copy, so it warns. A SourceRoot that cannot be fully enumerated is fatal — an
incomplete source scan cannot tell you what is missing.

Copying uses only built-in PowerShell commands and robocopy. No network service,
API, or credentials are used. When ManifestPath is supplied, the script writes
a JSON array containing one record per source file newly copied by this run,
with every destination it reached listed under DestinationPaths. No manifest is
written by default.

.PARAMETER SourceRoot
The SD-card directory to scan recursively for DJI .MP4 files. The directory
must already exist.

.PARAMETER DestinationRoots
One or more backup directory roots. Missing roots and date subfolders are
created by robocopy as needed. Each root is indexed and copied independently.

.PARAMETER ManifestPath
Optional path for a JSON manifest of files newly copied by this run. One entry
per source file — not per destination — containing the filename, recording date,
source path, size, copy timestamp, and a DestinationPaths array of every
destination it was copied to. This shape lets a downstream catalog run index
each clip exactly once. Existing files and files only proposed by -WhatIf are
not included. If omitted, no manifest is written.

.PARAMETER LogPath
Optional path to one append-only robocopy log shared by all destinations. The
parent directory is created when the first copy starts. This is recommended for
background jobs. If omitted, robocopy writes its normal output to the console.

.PARAMETER WhatIf
Shows destination copies and manifest writes that would occur without creating
directories, invoking robocopy, writing a log, or writing a manifest.

.EXAMPLE
PS> .\backup-drone-footage.ps1 -SourceRoot 'D:\DCIM\DJI_001' -DestinationRoots 'F:\Tune Clinic Recordings', 'G:\Recordings' -ManifestPath '.\new-footage.json' -LogPath '.\backup.log'

Copies eligible DJI videos to both roots, appends robocopy output to backup.log,
and writes successful per-destination copy records to new-footage.json.

.EXAMPLE
PS> .\backup-drone-footage.ps1 -SourceRoot 'D:\DCIM' -DestinationRoots 'F:\Drone Backup' -WhatIf

Scans and validates the source and destination state, then reports the copies
that would be made without changing the filesystem.

.EXAMPLE
PS> Start-Job -Name DroneBackup -ScriptBlock { & 'C:\Tools\backup-drone-footage.ps1' -SourceRoot 'D:\DCIM' -DestinationRoots 'F:\Drone Backup', 'G:\Recordings' -ManifestPath 'C:\Logs\new-footage.json' -LogPath 'C:\Logs\drone-backup.log' }

Starts a long-running copy in a background PowerShell job. Use Receive-Job
-Name DroneBackup -Keep to inspect status; robocopy details accumulate in the
specified log.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $SourceRoot,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]] $DestinationRoots,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $ManifestPath,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Only full-resolution video is eligible. DJI .LRF proxy files never pass this filter.
$VideoExtension = '.MP4'
$DjiVideoNamePattern = '^DJI_(?<date>\d{8})\d{6}_\d{4}_D\.MP4$'
$RobocopyOptions = @('/J', '/R:2', '/W:5', '/NP')

function ConvertTo-NormalizedDirectoryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath)

    if ($fullPath.Length -le $rootPath.Length) {
        return $rootPath
    }

    return $fullPath.TrimEnd([char[]] @('\', '/'))
}

function ConvertTo-UnresolvedFileSystemPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return ConvertTo-NormalizedDirectoryPath -Path $providerPath
}

function Test-DirectoryOverlap {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FirstPath,

        [Parameter(Mandatory = $true)]
        [string] $SecondPath
    )

    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $firstPrefix = $FirstPath.TrimEnd([char[]] @('\', '/')) + $separator
    $secondPrefix = $SecondPath.TrimEnd([char[]] @('\', '/')) + $separator

    return $FirstPath.Equals($SecondPath, $comparison) -or
        $FirstPath.StartsWith($secondPrefix, $comparison) -or
        $SecondPath.StartsWith($firstPrefix, $comparison)
}

function Get-DjiDateFolder {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FileName
    )

    $nameMatch = [System.Text.RegularExpressions.Regex]::Match(
        $FileName,
        $DjiVideoNamePattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )

    if (-not $nameMatch.Success) {
        return $null
    }

    $recordingDate = [datetime]::MinValue
    $parsed = [datetime]::TryParseExact(
        $nameMatch.Groups['date'].Value,
        'yyyyMMdd',
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None,
        [ref] $recordingDate
    )

    if (-not $parsed) {
        return $null
    }

    return $recordingDate.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
}

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "SourceRoot is not an existing directory: $SourceRoot"
}

$resolvedSourceRoot = ConvertTo-NormalizedDirectoryPath -Path (
    (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
)

$resolvedDestinationRoots = New-Object System.Collections.Generic.List[string]
$seenDestinationRoots = New-Object 'System.Collections.Generic.HashSet[string]' (
    [System.StringComparer]::OrdinalIgnoreCase
)

foreach ($destinationRoot in $DestinationRoots) {
    if ([string]::IsNullOrWhiteSpace($destinationRoot)) {
        throw 'DestinationRoots cannot contain an empty path.'
    }

    $resolvedDestinationRoot = ConvertTo-UnresolvedFileSystemPath -Path $destinationRoot

    if (Test-Path -LiteralPath $resolvedDestinationRoot -PathType Leaf) {
        throw "A destination root points to an existing file: $resolvedDestinationRoot"
    }

    if (Test-DirectoryOverlap -FirstPath $resolvedSourceRoot -SecondPath $resolvedDestinationRoot) {
        throw "SourceRoot and destination roots cannot overlap: $resolvedDestinationRoot"
    }

    if (-not $seenDestinationRoots.Add($resolvedDestinationRoot)) {
        throw "DestinationRoots contains the same path more than once: $resolvedDestinationRoot"
    }

    $resolvedDestinationRoots.Add($resolvedDestinationRoot)
}

$resolvedManifestPath = $null
if ($PSBoundParameters.ContainsKey('ManifestPath')) {
    $resolvedManifestPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ManifestPath)
    if (Test-Path -LiteralPath $resolvedManifestPath -PathType Container) {
        throw "ManifestPath points to a directory: $resolvedManifestPath"
    }
}

$resolvedLogPath = $null
if ($PSBoundParameters.ContainsKey('LogPath')) {
    $resolvedLogPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogPath)
    if (Test-Path -LiteralPath $resolvedLogPath -PathType Container) {
        throw "LogPath points to a directory: $resolvedLogPath"
    }
}

if ($resolvedManifestPath -and $resolvedLogPath -and
    $resolvedManifestPath.Equals($resolvedLogPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'ManifestPath and LogPath must be different files.'
}

Write-Verbose "Scanning source root: $resolvedSourceRoot"
# -Force: camera cards and copied trees routinely carry hidden/system attributes.
# Without it those clips are invisible here and would be dropped silently — the
# worst possible failure for a backup tool.
$sourceScanErrors = @()
$mp4Files = @(
    Get-ChildItem -LiteralPath $resolvedSourceRoot -Recurse -File -Force `
            -ErrorAction SilentlyContinue -ErrorVariable +sourceScanErrors |
        Where-Object { $_.Extension -ieq $VideoExtension } |
        Sort-Object -Property FullName
)

# A source we could not fully enumerate means we cannot know what is missing.
# Fail loudly rather than report a clean backup over a partial scan.
if ($sourceScanErrors.Count -gt 0) {
    $scanErrorList = ($sourceScanErrors | ForEach-Object { $_.ToString() }) -join '; '
    throw "SourceRoot could not be fully enumerated ($($sourceScanErrors.Count) error(s)): $scanErrorList"
}

$duplicateSourceNames = @(
    $mp4Files |
        Group-Object -Property Name |
        Where-Object { $_.Count -gt 1 }
)

# Duplicate filenames are ambiguous for a filename-keyed backup (e.g. -SourceRoot
# pointed at D:\DCIM spanning DJI_001 and DJI_002). Skip just the ambiguous names
# and copy everything else — aborting the whole run would strand hundreds of
# unrelated GB over one collision.
$duplicateNameSet = New-Object 'System.Collections.Generic.HashSet[string]' (
    [System.StringComparer]::OrdinalIgnoreCase
)

$mp4FilesFoundCount = $mp4Files.Count

if ($duplicateSourceNames.Count -gt 0) {
    foreach ($duplicateGroup in $duplicateSourceNames) {
        [void] $duplicateNameSet.Add($duplicateGroup.Name)
        $duplicatePaths = ($duplicateGroup.Group | ForEach-Object { $_.FullName }) -join '; '
        Write-Warning ("Skipping ambiguous duplicate filename '$($duplicateGroup.Name)' " +
            "found at: $duplicatePaths")
    }

    $mp4Files = @($mp4Files | Where-Object { -not $duplicateNameSet.Contains($_.Name) })
}

$eligibleFiles = New-Object System.Collections.Generic.List[object]
$unrecognizedNameCount = 0

foreach ($mp4File in $mp4Files) {
    $dateFolder = Get-DjiDateFolder -FileName $mp4File.Name
    $dateSource = 'FileName'

    if (-not $dateFolder) {
        # Not a standard DJI_<timestamp>_<seq>_D.MP4 name — legacy Phantom/Osmo
        # naming, a renamed clip, a "_001" split suffix. Back it up anyway, dated
        # from its mtime: the brief is "copy every MP4 except .LRF", and silently
        # dropping footage because we don't recognize its name is the one outcome
        # this tool must never produce.
        $dateFolder = $mp4File.LastWriteTime.ToString(
            'yyyy-MM-dd',
            [System.Globalization.CultureInfo]::InvariantCulture
        )
        $dateSource = 'LastWriteTime'
        $unrecognizedNameCount++
        Write-Warning ("MP4 filename is not in DJI format; dating it from LastWriteTime " +
            "($dateFolder): $($mp4File.FullName)")
    }

    $eligibleFiles.Add([pscustomobject] [ordered] @{
        File = $mp4File
        RecordingDate = $dateFolder
        DateSource = $dateSource
    })
}

$destinationStates = New-Object System.Collections.Generic.List[object]

foreach ($resolvedDestinationRoot in $resolvedDestinationRoots) {
    $existingNames = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::OrdinalIgnoreCase
    )

    if (Test-Path -LiteralPath $resolvedDestinationRoot -PathType Container) {
        Write-Verbose "Indexing destination by filename: $resolvedDestinationRoot"
        # -Force so an already-backed-up clip carrying a hidden attribute is seen
        # as present rather than re-copied. Enumeration errors here (an unreadable
        # subfolder, a Drive mount hiccup) are non-fatal: an incomplete index only
        # costs a redundant robocopy, which is a no-op when the file already
        # matches. Warn so a systematically unreadable destination is still visible.
        $destinationScanErrors = @()
        Get-ChildItem -LiteralPath $resolvedDestinationRoot -Recurse -File -Force `
                -ErrorAction SilentlyContinue -ErrorVariable +destinationScanErrors |
            Where-Object { $_.Extension -ieq $VideoExtension } |
            ForEach-Object { [void] $existingNames.Add($_.Name) }

        if ($destinationScanErrors.Count -gt 0) {
            Write-Warning ("Destination '$resolvedDestinationRoot' could not be fully indexed " +
                "($($destinationScanErrors.Count) error(s)); some files may be re-copied unnecessarily.")
        }
    }

    $destinationStates.Add([pscustomobject] [ordered] @{
        Root = $resolvedDestinationRoot
        ExistingNames = $existingNames
    })
}

$copyCandidates = New-Object System.Collections.Generic.List[object]
$alreadyPresentCount = 0

foreach ($eligibleFile in $eligibleFiles) {
    foreach ($destinationState in $destinationStates) {
        if ($destinationState.ExistingNames.Contains($eligibleFile.File.Name)) {
            $alreadyPresentCount++
            Write-Verbose "Already present at $($destinationState.Root): $($eligibleFile.File.Name)"
            continue
        }

        $destinationDirectory = Join-Path -Path $destinationState.Root -ChildPath $eligibleFile.RecordingDate
        $copyCandidates.Add([pscustomobject] [ordered] @{
            File = $eligibleFile.File
            RecordingDate = $eligibleFile.RecordingDate
            DestinationState = $destinationState
            DestinationDirectory = $destinationDirectory
            DestinationPath = Join-Path -Path $destinationDirectory -ChildPath $eligibleFile.File.Name
        })
    }
}

$robocopyCommand = $null
if ($copyCandidates.Count -gt 0) {
    $robocopyCommand = Get-Command -Name 'robocopy.exe' -CommandType Application
}

$newlyCopiedFiles = New-Object System.Collections.Generic.List[object]
$copyFailures = New-Object System.Collections.Generic.List[object]
$attemptedCopyCount = 0
$logDirectoryReady = -not [bool] $resolvedLogPath

foreach ($copyCandidate in $copyCandidates) {
    $action = "Copy $($copyCandidate.File.Name) with robocopy /J /R:2 /W:5 /NP"
    if (-not $PSCmdlet.ShouldProcess($copyCandidate.DestinationPath, $action)) {
        continue
    }

    if (-not $logDirectoryReady) {
        $logDirectory = Split-Path -Parent $resolvedLogPath
        if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
            [void] (New-Item -ItemType Directory -Path $logDirectory -Force)
        }
        $logDirectoryReady = $true
    }

    $robocopyArguments = @(
        $copyCandidate.File.DirectoryName,
        $copyCandidate.DestinationDirectory,
        $copyCandidate.File.Name
    ) + $RobocopyOptions

    if ($resolvedLogPath) {
        $robocopyArguments += "/LOG+:$resolvedLogPath"
    }

    $attemptedCopyCount++
    # robocopy returns 1 on a *successful* copy. Under PowerShell 7.4+
    # $PSNativeCommandUseErrorActionPreference is $true by default, which turns
    # any non-zero native exit into a terminating error — that would abort the
    # run on the very first file copied. Suppress it for this call only.
    # Console chatter is routed to the verbose stream so the script's success
    # stream carries nothing but the final summary object.
    $previousNativeErrorPreference = $null
    if (Test-Path -LiteralPath 'variable:PSNativeCommandUseErrorActionPreference') {
        $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
        $PSNativeCommandUseErrorActionPreference = $false
    }

    try {
        & $robocopyCommand.Source @robocopyArguments | ForEach-Object { Write-Verbose $_ }
        $robocopyExitCode = $LASTEXITCODE
    } finally {
        if ($null -ne $previousNativeErrorPreference) {
            $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
        }
    }
    $robocopyReportedCopy = ($robocopyExitCode -band 1) -eq 1
    $destinationFile = Get-Item -LiteralPath $copyCandidate.DestinationPath -Force -ErrorAction SilentlyContinue
    $destinationExists = $destinationFile -and -not $destinationFile.PSIsContainer

    # Defense in depth: robocopy verifies size itself, but this footage is
    # irreplaceable, so treat a size mismatch as a failed copy rather than trust
    # a single signal.
    if ($destinationExists -and $destinationFile.Length -ne $copyCandidate.File.Length) {
        $copyFailures.Add([pscustomobject] [ordered] @{
            FileName = $copyCandidate.File.Name
            DestinationPath = $copyCandidate.DestinationPath
            RobocopyExitCode = $robocopyExitCode
            Reason = "size mismatch: source $($copyCandidate.File.Length) bytes, destination $($destinationFile.Length) bytes"
        })
        continue
    }

    if ($robocopyExitCode -ge 8 -or ($robocopyReportedCopy -and -not $destinationExists)) {
        $copyFailures.Add([pscustomobject] [ordered] @{
            FileName = $copyCandidate.File.Name
            DestinationPath = $copyCandidate.DestinationPath
            RobocopyExitCode = $robocopyExitCode
        })
        continue
    }

    if (-not $robocopyReportedCopy) {
        if ($destinationExists) {
            [void] $copyCandidate.DestinationState.ExistingNames.Add($copyCandidate.File.Name)
            Write-Warning "Robocopy did not report a new copy, but the destination now exists; omitting it from the manifest: $($copyCandidate.DestinationPath)"
        }
        else {
            $copyFailures.Add([pscustomobject] [ordered] @{
                FileName = $copyCandidate.File.Name
                DestinationPath = $copyCandidate.DestinationPath
                RobocopyExitCode = $robocopyExitCode
            })
        }
        continue
    }

    [void] $copyCandidate.DestinationState.ExistingNames.Add($copyCandidate.File.Name)
    $newlyCopiedFiles.Add([pscustomobject] [ordered] @{
        FileName = $copyCandidate.File.Name
        RecordingDate = $copyCandidate.RecordingDate
        SourcePath = $copyCandidate.File.FullName
        DestinationRoot = $copyCandidate.DestinationState.Root
        DestinationPath = $copyCandidate.DestinationPath
        SizeBytes = [long] $copyCandidate.File.Length
        CopiedAtUtc = [datetime]::UtcNow.ToString('o')
        RobocopyExitCode = $robocopyExitCode
    })
}

$manifestWritten = $false
if ($resolvedManifestPath -and $PSCmdlet.ShouldProcess($resolvedManifestPath, 'Write JSON copy manifest')) {
    $manifestDirectory = Split-Path -Parent $resolvedManifestPath
    if (-not (Test-Path -LiteralPath $manifestDirectory -PathType Container)) {
        [void] (New-Item -ItemType Directory -Path $manifestDirectory -Force)
    }

    # One entry per SOURCE file, not per (file x destination). The manifest exists
    # so a downstream catalog run can index only what is new; emitting a clip once
    # per destination root would make a naive consumer index — and pay Claude
    # vision costs for — the same footage N times.
    $manifestEntries = @(
        $newlyCopiedFiles |
            Group-Object -Property SourcePath |
            ForEach-Object {
                $first = $_.Group[0]
                [pscustomobject] [ordered] @{
                    FileName = $first.FileName
                    RecordingDate = $first.RecordingDate
                    SourcePath = $first.SourcePath
                    SizeBytes = $first.SizeBytes
                    CopiedAtUtc = $first.CopiedAtUtc
                    DestinationPaths = @($_.Group | ForEach-Object { $_.DestinationPath })
                }
            }
    )

    $manifestJson = ConvertTo-Json -InputObject $manifestEntries -Depth 5
    if ($manifestEntries.Count -eq 0) {
        $manifestJson = '[]'
    }
    elseif (-not $manifestJson.TrimStart().StartsWith('[')) {
        # Some PowerShell versions unwrap a single-element array into a bare
        # object. Consumers always expect an array, so re-wrap only if needed.
        $manifestJson = "[$manifestJson]"
    }
    Set-Content -LiteralPath $resolvedManifestPath -Value $manifestJson -Encoding UTF8
    $manifestWritten = $true
}

$summary = [pscustomobject] [ordered] @{
    SourceRoot = $resolvedSourceRoot
    DestinationCount = $destinationStates.Count
    Mp4FilesFound = $mp4FilesFoundCount
    EligibleFiles = $eligibleFiles.Count
    UnrecognizedNamesDatedByMtime = $unrecognizedNameCount
    AlreadyPresent = $alreadyPresentCount
    CopyCandidates = $copyCandidates.Count
    CopiesAttempted = $attemptedCopyCount
    CopiesSucceeded = $newlyCopiedFiles.Count
    CopiesFailed = $copyFailures.Count
    DuplicateNamesSkipped = $duplicateNameSet.Count
    ManifestPath = if ($manifestWritten) { $resolvedManifestPath } else { $null }
    LogPath = $resolvedLogPath
}

# robocopy leaves its own (non-zero on success) exit code behind. Called in an
# existing session that would read as a failure to any wrapper checking
# $LASTEXITCODE, so reset it before returning.
$global:LASTEXITCODE = 0

Write-Output $summary

if ($copyFailures.Count -gt 0) {
    $failureDetails = $copyFailures |
        ForEach-Object {
            $detail = "$($_.FileName) -> $($_.DestinationPath) (robocopy exit $($_.RobocopyExitCode))"
            if ($_.PSObject.Properties['Reason']) { "$detail [$($_.Reason)]" } else { $detail }
        }
    throw "$($copyFailures.Count) copy operation(s) failed: $($failureDetails -join '; ')"
}
