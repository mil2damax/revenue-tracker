$SUPABASE_URL_SURVEYS = "https://ltbjavxegskmhyjqpext.supabase.co/rest/v1/medallia_surveys"
$SUPABASE_URL_REVIEWS = "https://ltbjavxegskmhyjqpext.supabase.co/rest/v1/reputation_reviews"
$SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0YmphdnhlZ3NrbWh5anFwZXh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MTU5NzksImV4cCI6MjA5NjI5MTk3OX0.mE-bSDLH7K9UXTqKDQKOuiEy9gv6Qi1xRj9Q2a9gw6I"
$LOG_FILE     = "C:\dev\catbird-supabase\medallia-upload-log.txt"

$PROPERTIES = @(
    @{ Code = "WKFCW"; Base = "C:\OD\Milkam Hospitality\Milkam Central - Documents\Mgmt\Meeneh\03 Front Office\01 WKFCW Night Audit" }
)

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

# Display name as it appears in the email body, used to strip the property name prefix off the comment
$PROP_DISPLAY_NAMES = @{ WKFCW = "WAKE FOREST RALEIGH AREA" }

function Parse-MedalliaEmail($html, $propCode, $fallbackDate) {
    # Convert <br> to newlines, strip remaining tags, decode HTML entities
    $text = $html -replace '(?i)<br\s*/?>', "`n"
    $text = $text -replace '<[^>]+>', ' '
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace '\s+', ' '
    $text = $text.Trim()

    # Match both X/10 (internal survey) and X/5 (Google review). The tokens
    # between the score and the comment vary by alert type (e.g. "WKFCW - NAME"
    # or "Etl - WKFCW - NAME"), so capture loosely and locate the property
    # display name inside — the comment is whatever follows it.
    $m = [regex]::Match($text, 'Overall Experience\s*-\s*(\d{1,2})\s*/\s*(5|10)\s+(.*?)\s*Click\s+here\s+to\s+see\s+the\s+record')
    if (-not $m.Success) { return $null }

    $score       = [int]$m.Groups[1].Value
    $denominator = [int]$m.Groups[2].Value
    $rest        = $m.Groups[3].Value.Trim()

    $displayName = $PROP_DISPLAY_NAMES[$propCode]
    $comment = $rest
    if ($displayName) {
        $idx = $rest.IndexOf($displayName)
        if ($idx -ge 0) {
            $comment = $rest.Substring($idx + $displayName.Length).Trim()
        }
    }

    [PSCustomObject]@{
        Denominator = $denominator
        Score       = $score
        Comment     = $comment
        Date        = $fallbackDate
        Property    = $propCode
    }
}

Log "===== Medallia upload run started ====="

$headers = @{
    "apikey"        = $SUPABASE_KEY
    "Authorization" = "Bearer $SUPABASE_KEY"
    "Prefer"        = "return=minimal"
}

foreach ($prop in $PROPERTIES) {
    $found = 0

    # Scan the last 60 days so emails that arrive late are still caught
    for ($i = 0; $i -le 60; $i++) {
        $day       = (Get-Date).AddDays(-$i)
        $yearPart  = $day.ToString("yyyy")
        $monthPart = $day.ToString("MM MMMM")
        $dayPart   = $day.ToString("MM.dd.yy")
        $folder    = Join-Path $prop.Base "$yearPart\$monthPart\$dayPart"

        if (-not (Test-Path $folder)) { continue }

        # Look for unprocessed Medallia text files (not already marked _uploaded)
        $files = Get-ChildItem $folder -Filter "Medallia_*.txt" -File |
                 Where-Object { $_.Name -notlike "*_uploaded*" }

        foreach ($f in $files) {
            $found++
            try {
                $html = Get-Content $f.FullName -Raw -Encoding UTF8

                # Date derived from filename (Medallia_yyyy-MM-dd_HHmm.txt)
                $fallbackDate = $day.ToString("yyyy-MM-dd")
                if ($f.Name -match 'Medallia_(\d{4}-\d{2}-\d{2})_') { $fallbackDate = $Matches[1] }

                $parsed = Parse-MedalliaEmail -html $html -propCode $prop.Code -fallbackDate $fallbackDate

                if (-not $parsed) {
                    Log "[$($prop.Code)] [SKIP] $($f.Name) : could not parse email content"
                    continue
                }

                # Everything goes to medallia_surveys; Google reviews are tagged in comments
                $isGoogle = ($parsed.Denominator -eq 5)
                $commentText = if ($isGoogle) { "Google Review$( if ($parsed.Comment) { ' · ' + $parsed.Comment } )" } else { $parsed.Comment }
                $row = [PSCustomObject]@{
                    property      = $parsed.Property
                    survey_date   = $parsed.Date
                    guest_name    = $null
                    overall_score = $parsed.Score
                    comments      = $commentText
                }
                $url  = $SUPABASE_URL_SURVEYS
                $desc = if ($isGoogle) { "google review $($parsed.Score)/5" } else { "survey $($parsed.Score)/10" }

                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes(($row | ConvertTo-Json -Compress))

                try {
                    Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bodyBytes | Out-Null
                    $newName = $f.Name -replace "\.txt$", "_uploaded.txt"
                    Rename-Item $f.FullName $newName
                    Log "[$($prop.Code)] [OK] $($f.Name) uploaded ($desc)"
                } catch {
                    Log "[$($prop.Code)] [ERROR] $($f.Name) : $($_.Exception.Message) : $($_.ErrorDetails.Message)"
                }
            } catch {
                Log "[$($prop.Code)] [EXCEPTION] $($f.Name) : $_"
            }
        }
    }

    if ($found -eq 0) {
        Log "[$($prop.Code)] No new Medallia files found in last 60 days"
    }
}

Log "===== Medallia upload run complete ====="
