import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { BrandWordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { mountShader } from "../../../site/src/shader";
import { request, SessionExpired, type Session } from "./api";

function AuthLayout({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  // CSS resolves the palette from the console's selected theme, including OS overrides.
  useEffect(() => mountShader(host.current!, canvas.current!, { palette: "hero", seed: 3, onLive: setLive }), []);
  return <main className="auth-layout">
    <div ref={host} className="telemetry-art auth-art">
      <canvas ref={canvas} aria-hidden className={`absolute inset-0 size-full transition-opacity duration-700 ${live ? "opacity-100" : "opacity-0"}`} />
      <div className="relative z-10 flex h-full flex-col justify-between gap-16 p-10 xl:p-14">
        <BrandWordmark markClassName="relative top-px" />
        <div className="max-w-md pb-8"><p className="mb-5 text-xs font-medium uppercase tracking-[0.18em] text-foreground/65">Phaethon telemetry</p><p className="text-balance text-5xl font-medium leading-[1.08] tracking-[-0.045em] xl:text-6xl">See how it’s<br />coming together.</p><p className="mt-6 max-w-xs text-pretty text-base leading-relaxed text-foreground/70">Usage, reliability, and feedback.<br />A shared view for the team building Phaethon.</p></div>
        <a href="https://phaethon.app" className="w-fit text-xs text-foreground/70 underline-offset-4 hover:underline">phaethon.app</a>
      </div>
    </div>
    <div className="flex min-w-0 flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-14 lg:hidden"><BrandWordmark markClassName="relative top-px" /></div>
        {children}
      </div>
    </div>
  </main>;
}

export function SessionLoading({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <AuthLayout><div className="space-y-7" role={error ? undefined : "status"} aria-label={error ? undefined : "Checking your session"}>
    {error ? <><h1 className="text-2xl font-medium tracking-tight">Couldn’t open the console</h1><p role="alert" className="text-sm text-destructive-foreground">{error}</p><Button variant="outline" onClick={onRetry}>Retry</Button></> : <><div className="space-y-3"><Skeleton className="h-7 w-28" /><Skeleton className="h-4 w-64" /></div><div className="space-y-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-11 w-full" /></div><div className="space-y-2"><Skeleton className="h-3 w-16" /><Skeleton className="h-11 w-full" /></div><Skeleton shape="pill" className="h-11 w-full" /><span className="sr-only">Checking your session…</span></>}
  </div></AuthLayout>;
}

export function SignIn({ onSignIn }: { onSignIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting.current || !email.trim() || !password) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await request<Session>("/login", { method: "POST", body: JSON.stringify({ email: email.trim(), password }) });
      setPassword(""); onSignIn(result);
    } catch (e) { setError(e instanceof SessionExpired ? "Those sign-in details weren’t recognized." : e instanceof Error ? e.message : "Couldn’t sign in. Try again."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <AuthLayout>
    <div className="mb-8"><p className="mb-3 text-xs font-medium text-muted-foreground">TEAM CONSOLE</p><h1 className="text-3xl font-medium tracking-tight">Sign in</h1><p className="mt-3 text-sm text-muted-foreground">Welcome back to Phaethon telemetry.</p></div>
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5" aria-busy={busy}>
      <div className="flex flex-col gap-2"><Label htmlFor="email">Email or username</Label><Input id="email" autoComplete="username" placeholder="you@example.com or username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} aria-describedby={error ? "sign-in-error" : undefined} className="[&_input]:h-11" autoFocus /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="password">Password</Label><div className="relative"><Input id="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" required maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} aria-describedby={error ? "sign-in-error" : undefined} className="[&_input]:h-11 [&_input]:pr-12" /><Button type="button" variant="ghost" size="icon-sm" className="absolute right-2 top-1/2 -translate-y-1/2" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((show) => !show)} disabled={busy}>{showPassword ? <Icon icon={icons.view} className="size-4" /> : <Icon icon={icons.view} className="size-4" />}</Button></div></div>
      {error ? <p id="sign-in-error" role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
      <Button type="submit" pending={busy} disabled={busy || !email.trim() || !password} className="mt-1 h-11 w-full sm:h-11">Sign in<Icon icon={icons.arrowRight} className="size-4" /></Button>
      <p className="text-center text-xs text-muted-foreground">Need access? Contact your team’s super admin.</p>
    </form>
  </AuthLayout>;
}
