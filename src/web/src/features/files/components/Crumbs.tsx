import { Fragment } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { cn } from "@/lib/utils";

/**
 * Where you are in the space's folders: the space, then each folder down to
 * the one on show (the current one is `aria-current`). Past three levels the
 * middle folds into "…", which goes up to the folder it stands for.
 */
export function Crumbs({
  spaceName,
  path,
  onGo,
  size = "default",
  className,
}: {
  spaceName: string;
  path: string;
  onGo: (folder: string) => void;
  size?: "default" | "sm";
  className?: string;
}) {
  const parts = path ? path.split("/") : [];
  const crumbs = [
    { label: spaceName, path: "" },
    ...parts.map((p, i) => ({
      label: p,
      path: parts.slice(0, i + 1).join("/"),
    })),
  ];
  const shown = crumbs.length > 3 ? [crumbs[0]!, { label: "…", path: crumbs[crumbs.length - 3]!.path, fold: true }, ...crumbs.slice(-2)] : crumbs;
  return (
    <nav aria-label="Folder" className={cn("flex min-w-0 items-center", className)}>
      <ol className="flex min-w-0 items-center gap-0.5">
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          return (
            <Fragment key={`${c.path}:${i}`}>
              {i > 0 ? (
                <li aria-hidden className="flex shrink-0 items-center">
                  <Icon icon={icons.chevronRight} className="size-3.5 text-subtle-foreground" />
                </li>
              ) : null}
              <li className={cn("flex min-w-0 items-center", last ? "shrink" : "shrink-[2]")}>
                <button
                  type="button"
                  onClick={() => onGo(c.path)}
                  aria-current={last ? "location" : undefined}
                  aria-label={"fold" in c ? `Up to ${c.path.split("/").pop()}` : undefined}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    size === "sm" ? "h-6 text-sm" : "h-7 text-sm",
                    last ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {i === 0 ? <Icon icon={icons.folder} className="size-4 shrink-0 text-muted-foreground" /> : null}
                  <Truncate className="min-w-0">{c.label}</Truncate>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
