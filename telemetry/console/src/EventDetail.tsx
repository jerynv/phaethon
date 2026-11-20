import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  errorMessage,
  eventName,
  formatDate,
  request,
  SessionExpired,
  type Detail,
  type EventSummary,
} from "./api";

export function EventDetail({
  item,
  onClose,
  onExpired,
}: {
  item: EventSummary;
  onClose: () => void;
  onExpired: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "start" });
  }, [item.id]);

  useEffect(() => {
    const controller = new AbortController();
    request<Detail>(`/events/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then(setDetail)
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof SessionExpired) onExpired();
        else setError(errorMessage(e, "Couldn’t load telemetry. Try again."));
      });
    return () => controller.abort();
  }, [item.id, onExpired]);

  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="min-w-0 scroll-mt-6 rounded-card border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Event detail"
    >
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-medium">{eventName(item.event)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDate(item.receivedAt)} · {item.platform} · {item.appVersion}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive-foreground">
          {error}
        </p>
      ) : detail ? (
        <DetailBody detail={detail} />
      ) : (
        <div role="status" aria-label="Loading event" className="space-y-4 p-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </section>
  );
}

function DetailBody({ detail }: { detail: Detail }) {
  const { messages, text } = detail.payload.data;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-muted-foreground">
        Signature verified. Self-signed events verify payload integrity; they do not attest the app or the
        report’s accuracy.
      </p>
      {messages?.map((message, i) => (
        <div key={i} className="rounded-lg border p-3">
          <h3 className="mb-2 text-xs font-medium capitalize text-muted-foreground">{message.role}</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
        </div>
      ))}
      {text ? <p className="whitespace-pre-wrap break-words text-sm">{text}</p> : null}
      <details>
        <summary className="cursor-pointer text-sm">Raw record</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-well p-3 font-mono text-xs">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </details>
    </div>
  );
}
