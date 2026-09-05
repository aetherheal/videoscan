$gPath = "G:\.shortcut-targets-by-id\123pT05uNBW13LMY8drgCjx6jLU86d7Ia\Recordings"
$groups = @{
  "2026-08-18" = @("DJI_20260818132434_0022_D.MP4","DJI_20260818133027_0023_D.MP4","DJI_20260818133519_0024_D.MP4","DJI_20260818134125_0025_D.MP4","DJI_20260818134348_0026_D.MP4","DJI_20260818152246_0027_D.MP4","DJI_20260818180815_0028_D.MP4","DJI_20260818191008_0029_D.MP4","DJI_20260818192531_0030_D.MP4")
  "2026-08-19" = @("DJI_20260819082331_0031_D.MP4")
  "2026-08-20" = @("DJI_20260820130629_0032_D.MP4","DJI_20260820221301_0033_D.MP4")
  "2026-08-21" = @("DJI_20260821162034_0034_D.MP4","DJI_20260821172206_0035_D.MP4","DJI_20260821201030_0036_D.MP4")
  "2026-08-22" = @("DJI_20260822095208_0037_D.MP4","DJI_20260822102236_0038_D.MP4")
}
$logF = "C:\Users\HP Victus 15L\Documents\Projects\videoscan\sd_copy_F.log"
$logG = "C:\Users\HP Victus 15L\Documents\Projects\videoscan\sd_copy_G.log"
$donePath = "C:\Users\HP Victus 15L\Documents\Projects\videoscan\sd_copy_DONE.txt"
foreach ($date in $groups.Keys) {
  $files = $groups[$date]
  robocopy "D:\DCIM\DJI_001" "F:\Tune Clinic Recordings\$date" $files /J /R:2 /W:5 /NP /LOG+:$logF
  robocopy "D:\DCIM\DJI_001" "$gPath\$date" $files /J /R:2 /W:5 /NP /LOG+:$logG
}
"DONE" | Out-File -FilePath $donePath -Encoding utf8
