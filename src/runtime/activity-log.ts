/** Category/icon hierarchy from T3's TimelineToolActivityIcon, using reported labels. */
export function activityKind(label: string): "search" | "file-text" | "folder" | "edit" | "terminal" | "tool" {
  if (/^(Searching|Finding|Looking up)\b/i.test(label)) return "search";
  if (/^(Reading|Opening|Viewing)\b/i.test(label)) return "file-text";
  if (/^(Listing|Browsing)\b/i.test(label)) return "folder";
  if (/^(Writing|Creating|Editing|Replacing|Updating)\b/i.test(label)) return "edit";
  if (/^(Running|Executing)\b/i.test(label)) return "terminal";
  return "tool";
}
