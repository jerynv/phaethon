export function Onboarding({ onDone }: { onDone: () => void }) {
  return (
    <main className="grid h-full place-items-center">
      <h1 className="font-semibold text-2xl">Welcome</h1>
      <button type="button" onClick={onDone}>Continue</button>
    </main>
  );
}
