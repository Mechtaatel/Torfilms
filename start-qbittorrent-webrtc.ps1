$ErrorActionPreference = 'Stop'
$qbtExecutable = 'D:\Program Files\qBittorrent\qbittorrent.exe'
$rtcScript = 'D:\ProjectTorFilms\qbittorrent-5.2.3\webtorrent-bridge\bridge.mjs'
$rtcNode = 'D:\Program Files\qBittorrent\webtorrent\node.exe'
foreach ($requiredPath in @($qbtExecutable, $rtcScript, $rtcNode)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Missing: $requiredPath" }
}
if (Get-Process -Name qbittorrent -ErrorAction SilentlyContinue) {
    throw 'Exit qBittorrent first, then run this launcher. Existing sessions are not stopped automatically.'
}
# Process-local overrides: no registry, firewall, VPN or system settings are changed.
$previousScript = $env:QBT_WEBTORRENT_SCRIPT
$previousNode = $env:QBT_WEBTORRENT_NODE
try {
    $env:QBT_WEBTORRENT_SCRIPT = $rtcScript
    $env:QBT_WEBTORRENT_NODE = $rtcNode
    Start-Process -FilePath $qbtExecutable -WorkingDirectory (Split-Path -Parent $qbtExecutable) -WindowStyle Hidden
} finally {
    $env:QBT_WEBTORRENT_SCRIPT = $previousScript
    $env:QBT_WEBTORRENT_NODE = $previousNode
}
