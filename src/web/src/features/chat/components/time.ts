/** "3:41 PM" today, "Tue 3:41 PM" this week, "Oct 9, 3:41 PM" before. */
export function timeWords(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now - at) / 86_400_000;
  if (new Date(now).toDateString() === d.toDateString()) return time;
  if (days < 6) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
