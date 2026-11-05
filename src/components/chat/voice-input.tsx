import { invoke } from "@tauri-apps/api/core";
import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PopoverSurface } from "vic-ui";

import { Button } from "@/components/ui/button";
import { IconTip } from "@/components/ui/tooltip";
import { platform } from "@/lib/platform";
import { inTauri } from "@/lib/tauri";

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SpeechWindow = {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** Dictation edits the draft. Sending remains an explicit composer action. */
export function VoiceInput({ disabled, onTranscript }: { disabled?: boolean; onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  const speech = useRef<Recognition | null>(null);
  const transcript = useRef(onTranscript);
  transcript.current = onTranscript;
  const native = inTauri() && platform() === "mac";
  const ctor = (window as unknown as SpeechWindow).SpeechRecognition ?? (window as unknown as SpeechWindow).webkitSpeechRecognition;

  useEffect(() => () => { speech.current?.abort(); }, []);
  useEffect(() => { if (disabled) speech.current?.abort(); }, [disabled]);
  if (!native && !ctor) return null;

  const start = async () => {
    if (listening) { speech.current?.stop(); return; }
    setError("");
    document.querySelector<HTMLTextAreaElement>('[data-space-pane][data-shown] [data-composer-input]')?.focus();
    if (native) {
      setLaunching(true);
      try { await invoke("voice_dictation_start"); }
      catch (e) { setError(String(e)); }
      finally { setLaunching(false); }
      return;
    }
    if (!ctor) return;
    const recognition = new ctor();
    speech.current = recognition;
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const text = Array.from(event.results, (result) => result[0]?.transcript ?? "").join(" ").trim();
      if (text) transcript.current(text);
    };
    recognition.onerror = ({ error: code }) => {
      setError(code === "not-allowed" ? "Allow microphone access to dictate." : code === "no-speech" ? "No speech detected. Try again." : "Dictation stopped. Try again.");
    };
    recognition.onend = () => { setListening(false); speech.current = null; };
    try { recognition.start(); setListening(true); }
    catch { setError("Dictation could not start. Try again."); }
  };
  const label = error || (listening ? "Stop dictation" : launching ? "Starting Dictation" : "Dictate message");
  return (
    <span className="relative inline-flex" data-voice-input="">
      <IconTip label={label} spoken={label}>
        <Button type="button" variant="ghost" size="icon-sm" round aria-label={label}
          disabled={disabled || launching} aria-pressed={listening}
          className={listening ? "text-danger" : "text-ink-secondary hover:text-ink"}
          onMouseDown={(event) => event.preventDefault()} onClick={() => void start()}>
          {listening ? <Square className="size-3 fill-current" /> : <Mic className="size-4" />}
        </Button>
      </IconTip>
      {error && <PopoverSurface role="status" className="absolute! bottom-full! left-0! z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] p-2! text-xs">{error}</PopoverSurface>}
    </span>
  );
}
