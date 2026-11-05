import type { ComponentProps, ComponentPropsWithoutRef, ReactNode } from "react";
import { Empty } from "vic-ui";

import { cn } from "@/lib/utils";

// The shared, centered content measure follows T3 Code's WorkspacePageContainer pattern.
export function WorkspacePage({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("ph-workspace-page mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 pt-8 pb-12 sm:px-10", className)} {...props} />;
}

export function WorkspacePageHeader({ title, description, actions, headingAs: Heading = "h2", headingProps, textClassName, actionsClassName, size = "page", as: Container = "header" }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingAs?: "h2" | "h3" | "h4";
  headingProps?: ComponentProps<"h2"> & Record<`data-${string}`, string | undefined>;
  textClassName?: string;
  actionsClassName?: string;
  size?: "page" | "section";
  as?: "header" | "div";
}) {
  return (
    <Container className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-3", size === "page" && "ph-workspace-heading")}>
      <div className={cn("flex min-w-0 flex-1 basis-60 flex-col gap-1", textClassName)}>
        <Heading {...headingProps} className={cn("w-fit max-w-full font-semibold text-ink wrap-break-word", size === "page" ? "text-2xl" : "text-lg", headingProps?.className)}>{title}</Heading>
        {description && <p className="text-sm text-ink-secondary">{description}</p>}
      </div>
      {actions && <div className={cn("flex flex-wrap items-center gap-2", actionsClassName)}>{actions}</div>}
    </Container>
  );
}

export function WorkspaceSection({ title, titleId, actions, headingAs = "h3", children, className, ...props }: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title: ReactNode;
  titleId: string;
  actions?: ReactNode;
  headingAs?: "h2" | "h3" | "h4";
}) {
  return (
    <section {...props} aria-labelledby={titleId} className={cn("flex min-w-0 flex-col gap-3 border-t border-line pt-5", className)}>
      <WorkspacePageHeader title={title} actions={actions} headingAs={headingAs} headingProps={{ id: titleId }} size="section" />
      {children}
    </section>
  );
}

export function WorkspaceEmpty({ title, description, actions, children, line, action, className, ...props }: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  line?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div {...props} className={cn("flex max-w-(--ph-measure) flex-col items-start gap-3", className)}>
      <Empty title={title} line={description ?? line} action={actions ?? action} className="mx-0 w-full justify-items-start px-0 py-4 text-start [&_.ui-empty-actions]:justify-start [&_.ui-empty-line]:max-w-none" />
      {children}
    </div>
  );
}
