import exchange from "@/assets/mail/exchange.svg";
import gmail from "@/assets/mail/gmail.svg";
import icloud from "@/assets/mail/icloud.svg";
import outlook from "@/assets/mail/outlook.svg";
import yahoo from "@/assets/mail/yahoo.svg";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { useLoad } from "@/features/study/use-load";
import type { MailApp, MailProvider } from "@/features/life/api";
import { invoke } from "@/lib/core";
import { cn } from "@/lib/utils";

/**
 * Which mail account something comes from, by its own logo: Gmail, iCloud,
 * Outlook, Microsoft (Exchange), Yahoo; a school account not on Exchange gets
 * a mortarboard, anything else an envelope. Never in a box, like the course
 * site marks. Sized with `size-*`.
 */

const LOGO: Partial<Record<MailProvider, string>> = { gmail, icloud, outlook, exchange, yahoo };
const LABEL: Record<MailProvider, string> = { icloud: "iCloud", gmail: "Gmail", outlook: "Outlook", exchange: "Exchange", yahoo: "Yahoo", school: "School", other: "Mail" };

export function providerLabel(p: MailProvider): string {
  return LABEL[p] ?? "Mail";
}

export function MailMark({ provider, className, decorative = true }: { provider: MailProvider; className?: string; decorative?: boolean }) {
  const src = LOGO[provider];
  const a11y = decorative ? { "aria-hidden": true as const, alt: "" } : { alt: LABEL[provider] ?? "Mail" };
  if (src) return <img src={src} {...a11y} data-slot="mail-mark" draggable={false} className={cn("size-6 shrink-0 object-contain", className)} />;
  return (
    <span data-slot="mail-mark" role={decorative ? undefined : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : LABEL[provider]} className={cn("inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground", className)}>
      <Icon icon={provider === "school" ? icons.courses : icons.mail} className="size-[85%]" />
    </span>
  );
}

/** An app Phaethon connects to (Mail, Outlook, Shortcuts) by its real icon from this Mac, else its brand glyph. */
export function AppMark({ app, className }: { app: MailApp | "shortcuts"; className?: string }) {
  const icon = useLoad(() => invoke<{ dataUrl: string | null }>("mail_app_icon", { app }).catch(() => ({ dataUrl: null })), [app], "mail:appIcon");
  if (icon.data?.dataUrl) return <img src={icon.data.dataUrl} alt="" aria-hidden draggable={false} data-slot="app-mark" className={cn("size-6 shrink-0 object-contain", className)} />;
  const glyph = app === "apple-mail" ? icons.apple : app === "outlook" ? icons.microsoft : app === "shortcuts" ? icons.automation : icons.mail;
  return (
    <span aria-hidden data-slot="app-mark" className={cn("inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground", className)}>
      <Icon icon={glyph} className="size-[80%]" />
    </span>
  );
}

export function appLabel(app: MailApp): string {
  return app === "apple-mail" ? "Apple Mail" : app === "outlook" ? "Outlook" : "Test mail";
}
