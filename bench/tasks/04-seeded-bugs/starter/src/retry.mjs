export function backoffDelay(attempt, baseMs = 100, _maxDelayMs = 1000) {
  // Seeded bug 3: ignores maxDelayMs cap
  return baseMs * (2 ** Math.max(0, attempt));
}
