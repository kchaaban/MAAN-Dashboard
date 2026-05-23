$csv = Get-Content -Raw -Encoding UTF8 "c:\Users\Khaled Chaabane\OneDrive - firstcity.ai\Documents\dev\data\simulation_data_view_202605131935.csv"
$csv = $csv -replace '`', '\`'
$js = "const CSV_DATA = ``$csv``;`nconst GEOJSON_DATA = [];`n"

$geojsons = Get-ChildItem "c:\Users\Khaled Chaabane\OneDrive - firstcity.ai\Documents\dev\data\*.geojson"
foreach ($g in $geojsons) {
    $content = Get-Content -Raw -Encoding UTF8 $g.FullName
    $content = $content -replace '`', '\`'
    $content = $content -replace '(?s)\r?\n', '' # minimize newlines to save space and avoid syntax issues
    $js += "GEOJSON_DATA.push({ filename: `"$($g.Name)`", content: ``$content`` });`n"
}

Set-Content -Path "c:\Users\Khaled Chaabane\OneDrive - firstcity.ai\Documents\dev\data\data.js" -Value $js -Encoding UTF8
