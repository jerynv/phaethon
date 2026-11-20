import { useState } from "react";
import { FilterSelect } from "./FilterSelect";
import { roleName, type Session } from "./api";
import { appearance, saveAppearance, type Appearance } from "./theme";

const THEMES: { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function Preferences({ session }: { session: Session }) {
  const [theme, setTheme] = useState(appearance);
  const changeTheme = (next: string) => {
    setTheme(next as Appearance);
    saveAppearance(next as Appearance);
  };
  return (
    <main className="flex max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Preferences</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your console, on this browser.</p>
      </div>
      <section className="rounded-card border bg-card">
        <h2 className="border-b px-5 py-4 text-sm font-medium">Appearance</h2>
        <div className="flex flex-wrap items-center justify-between gap-4 p-5">
          <span className="text-sm">Theme</span>
          <FilterSelect
            label="Theme"
            value={theme}
            options={THEMES}
            onChange={changeTheme}
            className="w-40"
          />
        </div>
      </section>
      <section className="rounded-card border bg-card">
        <h2 className="border-b px-5 py-4 text-sm font-medium">Your account</h2>
        <dl className="divide-y px-5 text-sm">
          <div className="flex flex-wrap justify-between gap-3 py-4">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{session.email}</dd>
          </div>
          <div className="flex justify-between gap-3 py-4">
            <dt className="text-muted-foreground">Role</dt>
            <dd>{roleName(session.role)}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
