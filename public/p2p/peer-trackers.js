export const publicTrackers = ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com', 'wss://tracker.btorrent.xyz']
export function peerTrackers (local, isPrivate = false) { return [...new Set([...(local ? [local] : []), ...(isPrivate ? [] : publicTrackers)])] }
