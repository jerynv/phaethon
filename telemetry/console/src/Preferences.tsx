import { useState } from "react";
import { FilterSelect } from "./FilterSelect";
import type { Session } from "./api";

import { appearance, applyAppearance, APPEARANCE_KEY, type Appearance } from "./theme";

export function Preferences({ session }: { session: Session }) {
  const [value, setValue] = useState(appearance);
  return <main className="flex max-w-3xl flex-col gap-8"><div><h1 className="text-2xl font-medium tracking-tight">Preferences</h1><p className="mt-2 text-sm text-muted-foreground">Your console, on this browser.</p></div>
    <section className="rounded-card border bg-card"><h2 className="border-b px-5 py-4 text-sm font-medium">Appearance</h2><div className="flex flex-wrap items-center justify-between gap-4 p-5"><span className="text-sm">Theme</span><FilterSelect label="Theme" value={value} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(next) => { const theme = next as Appearance; setValue(theme); applyAppearance(theme); try { localStorage.setItem(APPEARANCE_KEY, theme); } catch { /* The page still applies it. */ } }} className="w-40" /></div></section>
    <section className="rounded-card border bg-card"><h2 className="border-b px-5 py-4 text-sm font-medium">Your account</h2><dl className="divide-y px-5 text-sm"><div className="flex flex-wrap justify-between gap-3 py-4"><dt className="text-muted-foreground">Email</dt><dd className="break-all">{session.email}</dd></div><div className="flex justify-between gap-3 py-4"><dt className="text-muted-foreground">Role</dt><dd>{session.role === "owner" ? "Super admin" : "Viewer"}</dd></div></dl></section>
  </main>;
}
