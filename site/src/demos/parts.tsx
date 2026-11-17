import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconData } from "@/components/icon";
import { Folder01Icon, Search01Icon, Tick02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Bar } from "../stage/kit/window";

/**
 * The pieces of the app the demos are drawn from, in the app's own words and
 * shapes (src/web/src/features/chat/components/PendingCards.tsx): the card
 * that stops to ask, its keyed choices, and the sidebar.
 */

export function Card({ icon, title, meta, children, keys, className }: { icon: IconData; title: ReactNode; meta?: ReactNode; children?: ReactNode; keys?: ReactNode; className?: string }) {
  return (
    <div className={cn("ph-card", className)}>
      <div className="ph-card__head">
        <span className="ph-disc">
          <Icon icon={icon} />
        </span>
        <div className="ph-card__title">{title}</div>
        {meta ? <div className="ph-card__meta">{meta}</div> : null}
      </div>
      {children}
      {keys ? <div className="ph-keys">{keys}</div> : null}
    </div>
  );
}

export function Key({ k, children, target, primary, ...rest }: { k: string; children: ReactNode; target?: string; primary?: boolean } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className="ph-key" data-target={target} data-cursor={target ? "pointer" : undefined} data-primary={primary || undefined}>
      <span className="ph-kbd">{k}</span>
      {children}
    </span>
  );
}

/** What an answered card leaves behind in the thread. */
export function Record({ icon = Tick02Icon, children }: { icon?: IconData; children: ReactNode }) {
  return (
    <div className="ph-record">
      <Icon icon={icon} />
      <span>{children}</span>
    </div>
  );
}

/** The app's sidebar in one space: its switcher, search, files, and today's conversations, one of them open. */
export function Sidebar({ space, open }: { space: string; open: string }) {
  return (
    <div className="ph-side">
      <div className="ph-side__space">
        <span className="ph-side__dot" />
        <span className="ph-side__name">{space}</span>
        <Icon icon={UnfoldMoreIcon} className="ph-side__chev" />
      </div>
      <div className="ph-side__search">
        <Icon icon={Search01Icon} />
        <span>Search</span>
      </div>
      <div className="ph-side__row">
        <Icon icon={Folder01Icon} />
        <span>Files</span>
      </div>
      <div className="ph-side__label">Today</div>
      <div className="ph-side__chat" data-on>
        <span className="ph-side__ring" />
        <span className="ph-side__title">{open}</span>
      </div>
      {[70, 54, 62].map((w) => (
        <div key={w} className="ph-side__chat">
          <span className="ph-side__ring" />
          <Bar w={w} h={6} r={3} tone={2} />
        </div>
      ))}
    </div>
  );
}
