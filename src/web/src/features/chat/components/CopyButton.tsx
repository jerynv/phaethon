import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copies `text`; the visible label says what it copies, and changes to say it worked. */
export function CopyButton({
  text,
  label,
  done = "Copied",
  className,
  iconOnly = false,
  onCopied,
}: {
  text: string | (() => string);
  label: string;
  done?: string;
  className?: string;
  iconOnly?: boolean;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
      onCopied?.();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard refused (no focus, no permission): nothing to undo.
    }
  };
  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size={iconOnly ? "icon-xs" : "xs"}
      aria-label={iconOnly ? (copied ? done : label) : undefined}
      title={iconOnly ? label : undefined}
      className={cn("min-h-6 min-w-6", className)}
      onClick={() => void copy()}
    >
      <Icon aria-hidden className={cn("size-3.5", copied && "text-success")} />
      {!iconOnly && <span>{copied ? done : label}</span>}
    </Button>
  );
}
