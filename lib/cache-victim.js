// Prefer data outside the forward playback window. Within it, retain the
// nearest unread pieces rather than the most recently downloaded pieces.
export function cacheVictim (entries, keepIndex, window) {
  let victim
  let highest = -Infinity
  for (const index of entries.keys()) {
    if (index === keepIndex) continue
    if (!window) return index
    const outside = index < window.current || index > window.end
    const score = (outside ? 1e12 : 0) + Math.abs(index - window.current)
    if (score > highest) { highest = score; victim = index }
  }
  return victim
}
