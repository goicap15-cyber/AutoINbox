$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
& 'C:\Program Files\nodejs\npm.cmd' run build:all
& 'C:\Program Files\nodejs\node.exe' scripts\rebuild-native-for-electron.js restore
& 'C:\Program Files\nodejs\node.exe' scripts\rebuild-native-for-electron.js prepare
& 'C:\Program Files\nodejs\node.exe' scripts\rebuild-native-for-electron.js verify
& .\node_modules\.bin\electron-builder.cmd --win --config.directories.output=D:\crm_fbv2\autoinbox\release-image-preview-fix-full
& 'C:\Program Files\nodejs\node.exe' scripts\rebuild-native-for-electron.js restore
