import { useEffect, useState } from "react";
import { errorText, invoke } from "@/lib/core";

export function App() {
  const [info, setInfo] = useState<string>("Connecting…");
  useEffect(() => {
    invoke<{ version: string; platform: string; desktop: boolean }>("core_info").then(
      (i) => setInfo(`Phaethon ${i.version} on ${i.platform}${i.desktop ? " (desktop)" : ""}`),
      (e) => setInfo(errorText(e)),
    );
  }, []);
  return <main style={{ padding: 32 }}><h1>{info}</h1></main>;
}
