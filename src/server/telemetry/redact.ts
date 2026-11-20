/** Best-effort local removal of common identifiers. Free text can still identify someone. */
export function redactText(input: string, limit = 8000): string {
  return input
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, "[redacted key]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,}|AKIA[A-Z0-9]{16}|AIza[\w-]{20,})\b/g, "[redacted secret]")
    .replace(/\b(?:bearer\s+)[\w.+/=-]+/gi, "Bearer [redacted secret]")
    .replace(/\b((?:[\w-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token))(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|\[redacted secret\]|[^\s,"'}]+)/gi, "$1$2[redacted secret]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/(?:[A-Z]:\\(?:Users|Documents and Settings)\\|\/(?:Users|home)\/)[^\s<>"']+|~\/[^\s<>"']+/gi, "[redacted path]")
    .slice(0, limit);
}
