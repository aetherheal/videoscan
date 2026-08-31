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
destinations are still handled independently. DJI .LRF proxy files and .MP4
files that do not match the expected DJI naming convention are not copied.

Copying uses only built-in PowerShell commands and robocopy. No network service,
API, or credentials are used. When ManifestPath is supplied, the script writes
a JSON array containing one record for each successful destination copy. No
manifest is written by default.

.PARAMETER SourceRoot
The SD-card directory to scan recursively for DJI .MP4 files. The directory
must already exist.

.PARAMETER DestinationRoots
One or more backup directory roots. Missing roots and date subfolders are
created by robocopy as needed. Each root is indexed and copied independently.

.PARAMETER ManifestPath
Optional path for a JSON manifest of files newly copied by this run. Each entry
contains the source path, destination root, final destination path, recording
date, size, copy timestamp, and robocopy exit code. Existing files and files
only proposed by -WhatIf are not included. If omitted, no manifest is written.

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
$mp4Files = @(
    Get-ChildItem -LiteralPath $resolvedSourceRoot -Recurse -File |
        Where-Object { $_.Extension -ieq $VideoExtension } |
        Sort-Object -Property FullName
)

$duplicateSourceNames = @(
    $mp4Files |
        Group-Object -Property Name |
        Where-Object { $_.Count -gt 1 }
)

if ($duplicateSourceNames.Count -gt 0) {
    $duplicateList = ($duplicateSourceNames | ForEach-Object { $_.Name }) -join ', '
    throw "SourceRoot contains duplicate MP4 filenames, which is ambiguous for filename-based backups: $duplicateList"
}

$eligibleFiles = New-Object System.Collections.Generic.List[object]
$invalidNameCount = 0

foreach ($mp4File in $mp4Files) {
    $dateFolder = Get-DjiDateFolder -FileName $mp4File.Name
    if (-not $dateFolder) {
        $invalidNameCount++
        Write-Warning "Skipping MP4 with an unsupported or invalid DJI filename: $($mp4File.FullName)"
        continue
    }

    $eligibleFiles.Add([pscustomobject] [ordered] @{
        File = $mp4File
        RecordingDate = $dateFolder
    })
}

$destinationStates = New-Object System.Collections.Generic.List[object]

foreach ($resolvedDestinationRoot in $resolvedDestinationRoots) {
    $existingNames = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::OrdinalIgnoreCase
    )

    if (Test-Path -LiteralPath $resolvedDestinationRoot -PathType Container) {
        Write-Verbose "Indexing destination by filename: $resolvedDestinationRoot"
        Get-ChildItem -LiteralPath $resolvedDestinationRoot -Recurse -File |
            Where-Object { $_.Extension -ieq $VideoExtension } |
            ForEach-Object { [void] $existingNames.Add($_.Name) }
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
    & $robocopyCommand.Source @robocopyArguments
    $robocopyExitCode = $LASTEXITCODE
    $robocopyReportedCopy = ($robocopyExitCode -band 1) -eq 1
    $destinationExists = Test-Path -LiteralPath $copyCandidate.DestinationPath -PathType Leaf

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

    $manifestJson = ConvertTo-Json -InputObject $newlyCopiedFiles.ToArray() -Depth 4
    if ($newlyCopiedFiles.Count -eq 0) {
        $manifestJson = '[]'
    }
    Set-Content -LiteralPath $resolvedManifestPath -Value $manifestJson -Encoding UTF8
    $manifestWritten = $true
}

$summary = [pscustomobject] [ordered] @{
    SourceRoot = $resolvedSourceRoot
    DestinationCount = $destinationStates.Count
    Mp4FilesFound = $mp4Files.Count
    EligibleFiles = $eligibleFiles.Count
    InvalidNamesSkipped = $invalidNameCount
    AlreadyPresent = $alreadyPresentCount
    CopyCandidates = $copyCandidates.Count
    CopiesAttempted = $attemptedCopyCount
    CopiesSucceeded = $newlyCopiedFiles.Count
    CopiesFailed = $copyFailures.Count
    ManifestPath = if ($manifestWritten) { $resolvedManifestPath } else { $null }
    LogPath = $resolvedLogPath
}

Write-Output $summary

if ($copyFailures.Count -gt 0) {
    $failureDetails = $copyFailures |
        ForEach-Object { "$($_.FileName) -> $($_.DestinationPath) (robocopy exit $($_.RobocopyExitCode))" }
    throw "$($copyFailures.Count) robocopy operation(s) failed: $($failureDetails -join '; ')"
}
