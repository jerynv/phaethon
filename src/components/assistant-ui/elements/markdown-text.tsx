"use client";

// Adapted from the assistant-ui registry (MIT): restyled with Phaethon tokens.

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { type FC, memo, useMemo, useRef } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";

import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
  componentsByLanguage?: MarkdownTextPrimitiveProps["componentsByLanguage"];
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(value: T): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components, componentsByLanguage }) => {
  const stableComponents = useShallowStable(components);
  const stableComponentsByLanguage = useShallowStable(componentsByLanguage);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return { ...defaultComponents, ...memoizeMarkdownComponents(stableComponents) };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md max-w-(--ph-measure) text-md text-ink"
      components={markdownComponents}
      componentsByLanguage={stableComponentsByLanguage}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

/** The bar above a code block: its language and a Copy button that says when it worked. */
const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard({ copiedDuration: 2000 });
  return (
    <div className="mt-4 flex items-center justify-between gap-2 rounded-t-lg border border-b-0 border-line bg-surface py-1 ps-3 pe-1">
      <span className="font-mono text-xs text-ink-secondary">{language || "text"}</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-ink-secondary hover:text-ink"
        onClick={() => code && !isCopied && copyToClipboard(code)}
      >
        <Icon name={isCopied ? "check" : "copy"} className="size-(--ph-icon-size-sm)" />
        <span>{isCopied ? "Copied" : "Copy"}</span>
        <span className="sr-only"> code</span>
      </Button>
    </div>
  );
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1 className={cn("mt-6 mb-2 text-xl font-semibold tracking-tight first:mt-0 last:mb-0", className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn("mt-6 mb-2 text-lg font-semibold first:mt-0 last:mb-0", className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn("mt-5 mb-1.5 text-md font-semibold first:mt-0 last:mb-0", className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cn("mt-4 mb-1 text-md font-semibold first:mt-0 last:mb-0", className)} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 className={cn("mt-4 mb-1 text-base font-semibold first:mt-0 last:mb-0", className)} {...props} />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn("mt-4 mb-1 text-base font-semibold text-ink-secondary first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  p: ({ className, ...props }) => <p className={cn("my-3 first:mt-0 last:mb-0", className)} {...props} />,
  a: ({ className, ...props }) => (
    <a
      className={cn("text-accent-ink underline decoration-1 hover:decoration-2", className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-3 border-s-2 border-line-strong ps-4 text-ink-secondary", className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-3 ms-5 list-disc marker:text-ink-tertiary [&>li]:mt-1", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-3 ms-5 list-decimal marker:text-ink-secondary [&>li]:mt-1", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("ps-1", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-5 border-line", className)} {...props} />,
  table: ({ className, ...props }) => (
    <div className="my-4 w-fit max-w-full overflow-x-auto rounded-lg border border-line" tabIndex={0} role="group" aria-label="Table">
      <table className={cn("border-collapse text-base", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }) => <thead className={cn("bg-surface", className)} {...props} />,
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border-b border-line px-3 py-2 text-start font-semibold [[align=center]]:text-center [[align=right]]:text-end",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "border-b border-line px-3 py-2 align-top text-start [[align=center]]:text-center [[align=right]]:text-end",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => <tr className={cn("last:[&>td]:border-b-0", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("font-semibold", className)} {...props} />,
  sup: ({ className, ...props }) => <sup className={cn("[&>a]:text-xs [&>a]:no-underline", className)} {...props} />,
  pre: ({ className, ...props }) => (
    <pre
      tabIndex={0}
      className={cn(
        "overflow-x-auto rounded-b-lg border border-line bg-surface-sunken p-3 font-mono text-sm leading-normal",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock && "rounded-xs border border-line bg-surface px-1 py-px font-mono text-sm",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
