import { AlertDialog } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

/**
 * A task in a dialog, one decision at a time: the shared step-by-step pattern
 * (making flashcards or a quiz, importing courses). Built on the Radix Dialog
 * (the window) and AlertDialog (the ask before discarding).
 *
 *   <WizardDialogContent dirty={…} onClose={…} discard={{ title, body }}>
 *     <form onSubmit={next} onKeyDown={enterAdvances} className={WIZARD_FORM}>
 *       <WizardHeader steps={…} current={…} title="…" titleRef={…} />
 *       <WizardBody>…one decision…</WizardBody>
 *       <WizardFooter onBack={…} next={<Button type="submit" data-step-next="">Next</Button>} />
 *     </form>
 *   </WizardDialogContent>
 *
 * The flow keeps its state above the steps, so Back keeps what was entered.
 * Next validates its step and says what is missing in plain words beside the
 * field; Enter (in a field, a checkbox or a radio) is Next. Each step's
 * heading takes focus as it shows and is described by "Step 2 of 4", and the
 * step list marks the current step (aria-current="step"). The last step
 * reviews everything before the one action that can't simply be taken back.
 * Escape, Close and Cancel ask before discarding what was entered.
 *
 * Keyboard: Tab through the step's fields, then Back, Cancel, Next; Enter is
 * Next; Escape asks, then closes. Header and footer stay put while a long
 * step (a long course list, large text) scrolls between them.
 */

export type WizardStep = { id: string; label: string };

/** The classes a step's form takes inside WizardDialogContent: header, scrolling body, footer. */
export const WIZARD_FORM = "flex min-h-0 flex-1 flex-col gap-4";

const CloseContext = createContext<() => void>(() => {});
/** Close the wizard, asking first when something was entered. */
export const useWizardClose = () => useContext(CloseContext);

/**
 * The dialog around a wizard. `dirty`: something was entered or chosen, so
 * Escape, Close and Cancel ask before discarding it. `locked`: nothing closes
 * it by accident (while something runs); Close still can.
 */
export function WizardDialogContent({
  dirty,
  locked = false,
  onClose,
  discard,
  children,
  className,
  onEscapeKeyDown,
  onCloseAutoFocus,
  ...props
}: Omit<ComponentProps<typeof DialogContent>, "showCloseButton"> & {
  dirty: boolean;
  locked?: boolean;
  onClose: () => void;
  discard: { title: string; body: string };
}) {
  const [asking, setAsking] = useState(false);
  // Discarding: the ask doesn't put focus back in the wizard (it is closing); the dialog returns it to what opened it.
  const discarding = useRef(false);
  // What had focus when it opened: focus goes back there when it closes (Radix returns it only to a Dialog.Trigger).
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && typeof document !== "undefined") {
    const a = document.activeElement;
    opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
  }
  const request = useCallback(() => (dirty ? setAsking(true) : onClose()), [dirty, onClose]);
  return (
    <CloseContext.Provider value={request}>
      <DialogContent
        {...props}
        showCloseButton={false}
        data-wizard=""
        // The step's body scrolls between header and footer; where even they don't fit (very large text in a
        // small window) the whole dialog scrolls instead, so nothing is ever cut off.
        className={cn("flex flex-col gap-4 overflow-y-auto", className)}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
        }}
        onEscapeKeyDown={(e) => {
          onEscapeKeyDown?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          if (!locked) request();
        }}
        // Only Escape, Close and Cancel close it: a slip outside never loses a half-done step.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {children}
        <Button type="button" variant="ghost" size="icon" aria-label="Close" data-wizard-close="" className="absolute top-3 right-3" onClick={request}>
          <Icon name="close" />
        </Button>
        <AlertDialog.Root open={asking} onOpenChange={setAsking}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-50 bg-(--ph-overlay)" />
            <AlertDialog.Content
              onCloseAutoFocus={(e) => discarding.current && e.preventDefault()}
              data-wizard-discard=""
              className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-var(--ph-space)*8)] max-w-(--ph-measure) -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-line bg-raised p-5 text-ink shadow-lg outline-none"
            >
              <AlertDialog.Title className="text-lg leading-tight font-semibold">{discard.title}</AlertDialog.Title>
              <AlertDialog.Description className="text-base text-ink-secondary">{discard.body}</AlertDialog.Description>
              {/* Radix puts focus on Keep going: Enter or Escape never discards by accident. */}
              <div className="flex flex-wrap justify-end gap-x-[max(var(--ph-target-min),calc(var(--ph-space)*4))] gap-y-2 pt-1">
                <AlertDialog.Cancel asChild>
                  <Button type="button" variant="outline" data-wizard-keep="">
                    Keep going
                  </Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <Button type="button" variant="destructive" 
                    data-wizard-discard-confirm=""
                    onClick={() => {
                      discarding.current = true;
                      onClose();
                    }}
                  >
                    Discard
                  </Button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </DialogContent>
    </CloseContext.Provider>
  );
}

/**
 * Enter anywhere in a step is Next: in a checkbox or a radio, and on the
 * step's heading (where focus lands as a step shows), not only in a text field
 * (where the form submits by itself). Buttons, links and multi-line fields keep
 * their own Enter. Pass as the step form's onKeyDown.
 */
export function enterAdvances(e: KeyboardEvent<HTMLFormElement>) {
  const t = e.target as HTMLElement;
  if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
  // A Radix radio (a button) doesn't take Enter itself, by the ARIA pattern: Enter there is Next too.
  if (t.getAttribute("role") === "radio") {
    e.preventDefault();
    e.currentTarget.requestSubmit();
    return;
  }
  if (e.defaultPrevented) return;
  if (t.closest("button, a, textarea, select, summary, [role=button], [role=combobox], [role=listbox], [role=option]")) return;
  // Text fields submit the form natively.
  if (t instanceof HTMLInputElement && t.type !== "checkbox" && t.type !== "radio") return;
  e.preventDefault();
  e.currentTarget.requestSubmit();
}

/**
 * The step list, "Step 2 of 4" (and what comes next), and the step's heading
 * (the dialog's title). The heading takes focus whenever `current` changes.
 * `steps` empty: a heading alone (a page that isn't one of the steps, like
 * progress or a result).
 */
export function WizardHeader({
  steps,
  current,
  title,
  titleRef,
  children,
  titleProps,
  task,
}: {
  /** What the whole task is ("Make a quiz"), said before the step number. */
  task?: string;
  steps: readonly WizardStep[];
  current: string;
  title: ReactNode;
  titleRef: RefObject<HTMLHeadingElement | null>;
  children?: ReactNode;
  titleProps?: Record<`data-${string}`, string>;
}) {
  const at = steps.findIndex((s) => s.id === current);
  const labelId = useId();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [current, titleRef]);
  const numbered = at >= 0 && steps.length > 1;
  const next = numbered ? steps[at + 1] : undefined;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 pe-[calc(var(--ph-control-height)+var(--ph-space)*2)]" data-wizard-header="">
      {numbered && (
        <>
          <ol aria-label="Steps" className="flex gap-1" data-wizard-steps="">
            {steps.map((s, i) => (
              <li key={s.id} aria-current={i === at ? "step" : undefined} className="flex min-w-0 flex-1" data-wizard-step={s.id}>
                <span className="sr-only">{`${s.label}${i < at ? ", done" : ""}`}</span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-(--ph-space) w-full rounded-full",
                    i <= at ? "bg-accent-fill forced-colors:bg-[CanvasText]" : "bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]",
                  )}
                />
              </li>
            ))}
          </ol>
          <p id={labelId} className="flex flex-wrap gap-x-2 text-sm text-ink-secondary">
            {task && <span data-wizard-task="">{`${task}:`}</span>}
            <span className="font-medium text-ink" data-step-label="">{`Step ${at + 1} of ${steps.length}`}</span>
            {next && <span data-step-next-is="">{`Next: ${next.label}`}</span>}
          </p>
        </>
      )}
      <DialogTitle ref={titleRef} tabIndex={-1} aria-describedby={numbered ? labelId : undefined} className="self-start rounded-xs" {...titleProps}>
        {title}
      </DialogTitle>
      {children && <div className="flex flex-col gap-1.5 text-base text-ink-secondary">{children}</div>}
    </div>
  );
}

/** The step's one decision; scrolls between the header and the footer when it is long. */
export function WizardBody({ children, className, ...props }: ComponentProps<"div">) {
  return (
    // A little room on every side, so a focused field's ring is never cut by the scroller.
    <div {...props} className={cn("-m-1 flex min-h-(--ph-wizard-body-min) flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-1", className)} data-wizard-body="">
      {children}
    </div>
  );
}

/** Back (from the second step on), Cancel (asks before discarding), then the step's own Next. */
export function WizardFooter({ onBack, next, cancel = true, children }: { onBack?: () => void; next?: ReactNode; cancel?: boolean; children?: ReactNode }) {
  const close = useWizardClose();
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line pt-3" data-wizard-footer="">
      {onBack && (
        <Button type="button" variant="ghost" onClick={onBack} data-step-back="" className="me-auto">
          <Icon name="chevron-left" />
          Back
        </Button>
      )}
      {children}
      {cancel && (
        <Button type="button" variant="outline" onClick={close} data-wizard-cancel="">
          Cancel
        </Button>
      )}
      {next}
    </div>
  );
}

/** A plain-words problem with a step's field, tied to it by id. */
export function StepError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sm text-danger-ink" data-field-error="">
      <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The review step: what was chosen, each with a way back to its step. */
export function ReviewList({ items }: { items: { id: string; label: string; value: ReactNode; onChange?: () => void }[] }) {
  return (
    // A row each: what, what was chosen, Change; the label sits above the value only where the row is narrow.
    <dl className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface" data-wizard-review="">
      {items.map((it) => (
        // dt and dd straight inside the row (as a definition list needs); Change sits at the end of the dd.
        <div key={it.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-0.5" data-review-item={it.id}>
          <dt className="w-(--ph-review-label-width) shrink-0 py-1 text-sm font-medium text-ink-secondary">{it.label}</dt>
          <dd className="flex min-w-0 flex-[1_1_10em] items-center justify-between gap-x-3 text-base text-ink">
            <div className="min-w-0 py-1 wrap-break-word">{it.value}</div>
            {it.onChange && (
              <Button type="button" variant="ghost" size="sm" onClick={it.onChange} data-review-change={it.id}>
                Change<span className="sr-only">{` ${it.label.toLowerCase()}`}</span>
              </Button>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
