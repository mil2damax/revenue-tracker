$SUPABASE_URL = "https://ltbjavxegskmhyjqpext.supabase.co/functions/v1/process-night-audit"
$SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0YmphdnhlZ3NrbWh5anFwZXh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQxNDA4NTksImV4cCI6MjA1OTcxNjg1OX0.2uKBcXHEDCaRGMbFHhB6tgdJOnFJGpPo3hWxAWHFHkQ"
$LOG_FILE     = "C:\dev\catbird-supabase\upload-log.txt"

$PROPERTIES = @(
    @{ Code = "WKFCW"; Base = "C:\OD\Milkam Hospitality\Milkam Central - Documents\Mgmt\Meeneh\03 Front Office\01 WKFCW Night Audit" }
    @{ Code = "RDURM"; Base = "C:\OD\Milkam Hospitality\Milkam Central - Documents\Mgmt\WFH\03 Front Office\01 RDURM Night Audit" }
)

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

Log "===== Upload run started ====="

# Scan the last 3 day-folders, not just yesterday's: some files land in a
# folder after its 6am run has already passed (Business Track email arrives
# 6:50-7:40am; OneDrive sync outages delay whole days). Re-uploading is safe —
# the Edge Function upserts everything.
foreach ($prop in $PROPERTIES) {
    for ($i = 1; $i -le 3; $i++) {
        $day        = (Get-Date).AddDays(-$i)
        $folderName = $day.ToString("MM.dd.yy")
        $folder     = Join-Path $prop.Base "$($day.ToString('yyyy'))\$($day.ToString('MM MMMM'))\$folderName"

        if (-not (Test-Path $folder)) {
            if ($i -eq 1) { Log "[$($prop.Code)] Folder not found: $folder - skipping" }
            continue
        }

        # Normalize: HotelKey's Settlement by Payment Type attachment arrives with an
        # unwieldy name ("MM.dd.yy Jul 09, 2026-WKFCW-...-settlement-by-payment-type
        # .xlsx.xlsx"). Move it to the year's CC Recon folder under a clean name —
        # all credit-card reconciliation data lives there.
        $reconDir = Join-Path $prop.Base "$($day.ToString('yyyy'))\CC Recon"
        Get-ChildItem $folder -File | Where-Object { $_.Name -match 'settlement-by-payment-type' } | ForEach-Object {
            if (-not (Test-Path $reconDir)) { New-Item -ItemType Directory -Path $reconDir -Force | Out-Null }
            $clean = Join-Path $reconDir "$folderName Settlement by Payment Type.xlsx"
            Move-Item $_.FullName $clean -Force
            Log "[$($prop.Code)] moved $($_.Name) -> CC Recon\$folderName Settlement by Payment Type.xlsx"
        }
        # Same normalization for Business Track CSVs that land in day folders
        # (older flow config saved them there; CC Recon is their home).
        Get-ChildItem $folder -File -Filter "*business track settlement.csv" | ForEach-Object {
            if (-not (Test-Path $reconDir)) { New-Item -ItemType Directory -Path $reconDir -Force | Out-Null }
            $clean = Join-Path $reconDir "$folderName Business Track Settlement.csv"
            Move-Item $_.FullName $clean -Force
            Log "[$($prop.Code)] moved $($_.Name) -> CC Recon\$folderName Business Track Settlement.csv"
        }

        $files = @(Get-ChildItem $folder -File | Where-Object { $_.Extension -in '.xlsx','.xls','.csv' })
        if ($files.Count -eq 0) {
            if ($i -eq 1) { Log "[$($prop.Code)] No report files in $folder - skipping" }
            continue
        }

        Log "[$($prop.Code)] $folderName : $($files.Count) files"

        foreach ($f in $files) {
            # Commas/semicolons in filenames break curl's -F multipart syntax
            # (e.g. HotelKey's "Jul 04, 2026-...-settlement-by-payment-type.xlsx").
            # Stage such files under a sanitized temp name; keep the MM.dd.yy date
            # prefix, which the Edge Function reads to determine the report date.
            $uploadPath = $f.FullName
            $tempCopy = $null
            if ($f.Name -match '[,;]') {
                $safeName = ($f.Name -replace '[,;]', '') -replace '\s+', ' '
                $tempCopy = Join-Path $env:TEMP $safeName
                Copy-Item $f.FullName $tempCopy -Force
                $uploadPath = $tempCopy
            }

            $result = & "C:\WINDOWS\system32\curl.exe" -s -X POST $SUPABASE_URL `
                -H "Authorization: Bearer $SUPABASE_KEY" `
                -F "file=@`"$uploadPath`"" `
                -F "property=$($prop.Code)"
            Log "[$($prop.Code)] $($f.Name) : $result"

            if ($tempCopy) { Remove-Item $tempCopy -Force -ErrorAction SilentlyContinue }
        }
    }

    # CC Recon folder: upload anything new/changed in the last 4 days (covers the
    # settlement files normalized above plus Business Track CSVs saved by the
    # Power Automate flow, without re-uploading the whole year's archive daily).
    $reconAll = Join-Path $prop.Base "$((Get-Date).ToString('yyyy'))\CC Recon"
    if (Test-Path $reconAll) {
        $recent = @(Get-ChildItem $reconAll -File |
            Where-Object { $_.Extension -in '.xlsx','.xls','.csv' -and $_.LastWriteTime -gt (Get-Date).AddDays(-4) })
        if ($recent.Count -gt 0) {
            Log "[$($prop.Code)] CC Recon : $($recent.Count) recent files"
            foreach ($f in $recent) {
                $result = & "C:\WINDOWS\system32\curl.exe" -s -X POST $SUPABASE_URL `
                    -H "Authorization: Bearer $SUPABASE_KEY" `
                    -F "file=@`"$($f.FullName)`"" `
                    -F "property=$($prop.Code)"
                Log "[$($prop.Code)] CC Recon\$($f.Name) : $result"
            }
        }
    }
}

Log "===== Upload run complete ====="
