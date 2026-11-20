import fs from "node:fs";
import path from "node:path";

/** A vault with spaces, memories, people, mail accounts, a profile and schedules, for the Settings › Memory, People, Mail and Automations tests. Returns the fake mail file. */
export function seedLife(home: string): string {
  const vault = path.join(home, "Phaethon", "default");
  const st = path.join(vault, ".phaethon");
  for (const s of ["school", "work", "personal"]) fs.mkdirSync(path.join(vault, "spaces", s, ".phaethon"), { recursive: true });
  fs.mkdirSync(st, { recursive: true });
  const now = Date.now();
  const H = 3_600_000, D = 24 * H;
  const sat = new Date(now); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7)); sat.setHours(6, 0, 0, 0);
  const base = { keywords: [], people: [], created: now - D, updated: now - D };
  const items = [
    { ...base, id: "m_1", kind: "event", text: "Team meeting with Dana about the Q4 roadmap", space: "work", scope: "space", when: sat.getTime(), status: "active", origin: "agent", keywords: ["meeting", "roadmap"], people: ["dana-reyes"] },
    { ...base, id: "m_2", kind: "event", text: "CS101 Test 1", space: "school", scope: "space", when: now - 20 * H, status: "active", origin: "agent", keywords: ["test", "cs101"] },
    { ...base, id: "m_3", kind: "state", text: "Food poisoning, told my bosses I can’t come in", space: "work", scope: "vault", until: now + 40 * H, status: "active", origin: "agent", keywords: ["sick"] },
    { ...base, id: "m_4", kind: "task", text: "Send Dana the revised slides", space: "work", scope: "space", when: now + 3 * D, status: "active", origin: "user", people: ["dana-reyes"] },
    { ...base, id: "m_5", kind: "note", text: "Prefers written check-ins over calls; feels micromanaged on deadlines", space: "work", scope: "space", status: "active", origin: "review" },
    { ...base, id: "m_6", kind: "event", text: "Dentist appointment", space: "personal", scope: "space", when: now - 5 * D, status: "done", outcome: "Went fine, next cleaning in six months", closed: now - 4 * D, origin: "agent", source: { space: "personal", thread: "t_dentist" } },
    { ...base, id: "m_7", kind: "state", text: "Travelling to Chicago", space: "personal", scope: "vault", until: now - 2 * D, status: "expired", closed: now - 2 * D, origin: "agent" },
    { ...base, id: "m_8", kind: "task", text: "Ask about the extension for HW 5", space: "school", scope: "space", status: "dismissed", closed: now - 6 * D, origin: "agent", source: { space: "school", thread: "t_hw5" } },
  ];
  fs.writeFileSync(path.join(st, "memories.json"), JSON.stringify({ version: 1, items }));
  fs.mkdirSync(path.join(vault, "memory", "people"), { recursive: true });
  const person = (p: Record<string, unknown>) => fs.writeFileSync(path.join(vault, "memory", "people", `${p.id}.json`), JSON.stringify({ aliases: [], emails: [], phones: [], links: [], notes: [], interactions: [], created: 1, updated: 1, source: "user", ...p }));
  person({
    id: "dana-reyes", name: "Dana Reyes", aliases: ["my boss", "Dana R"], relation: "Manager", org: "Acme Corp", title: "Engineering lead", emails: ["dana@acme.com"], phones: ["+1 812 555 0142"],
    links: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/danareyes" }], spaces: ["work"], notes: ["Prefers a written agenda before meetings", "Values heads-up early when a deadline slips"],
    interactions: [
      { at: now - 9 * D, channel: "meeting", summary: "1:1 about the roadmap and hiring" },
      { at: now - 3 * D, channel: "email", direction: "in", summary: "Vacation approved" },
      { at: now - 1 * D, channel: "email", direction: "out", summary: "Out sick today" },
      { at: now - 2 * H, channel: "chat", summary: "Asked an agent to draft the status update", ref: { space: "work", thread: "t_status" } },
    ],
  });
  person({ id: "sam-lee", name: "Sam Lee", relation: "Classmate", org: "State U", emails: ["samlee@example.edu"], spaces: ["*"], source: "mail", interactions: [{ at: now - 4 * D, channel: "email", direction: "in", summary: "CS101 study group Thursday?" }] });
  person({ id: "priya-natarajan", name: "Priya Natarajan", relation: "Sister", spaces: ["personal"], source: "agent" });
  const mailFile = path.join(home, "fake-mail.json");
  fs.writeFileSync(mailFile, JSON.stringify({
    accounts: [
      { id: "school", name: "State U", emails: ["student@example.edu"], fullName: "Alex Morgan", type: "exchange" },
      { id: "gmail", name: "Gmail", emails: ["jeryn@gmail.com"], fullName: "Alex Morgan", type: "gmail" },
      { id: "icloud", name: "iCloud", emails: ["jeryn@icloud.com", "jeryn@me.com"], fullName: "Alex Morgan", type: "icloud" },
    ],
    messages: [],
  }));
  fs.writeFileSync(path.join(st, "mail.json"), JSON.stringify({
    connectors: { fake: true },
    known: [
      { key: "fake:school", app: "fake", name: "State U", emails: ["student@example.edu"], provider: "school", enabled: true },
      { key: "fake:gmail", app: "fake", name: "Gmail", emails: ["jeryn@gmail.com"], provider: "gmail", enabled: true },
      { key: "fake:icloud", app: "fake", name: "iCloud", emails: ["jeryn@icloud.com", "jeryn@me.com"], provider: "icloud", enabled: true },
    ],
    access: { "fake:school": ["school"], "fake:gmail": ["personal", "work"] },
    allowSend: true, sendDelaySeconds: 60, indexForPeople: true, addPeopleFromMail: false,
  }));
  fs.writeFileSync(path.join(vault, "memory", "profile.md"), "# About me\n\nJeryn, CS student at IU. Works part time at Acme.\n\n- Short answers first, detail on request.\n- Mornings are for deep work.\n\n## What agents have noticed\n\n- Studies best with practice tests, not rereading\n- Usually replies to mail in the evening\n");
  fs.writeFileSync(path.join(st, "schedules.json"), JSON.stringify({ schedules: [
    { id: "s_seed01", space: "work", title: "Morning inbox check", prompt: "Summarise unread mail from people I know and draft replies to anything urgent.", cron: "30 7 * * 1-5", enabled: true, created: now - D, updated: now - D, origin: "user" },
    { id: "s_seed02", space: "school", title: "Weekly study plan", prompt: "Look at what's due this week and make a study plan.", cron: "0 18 * * 0", enabled: false, created: now - D, updated: now - D, origin: "agent" },
  ] }));
  return mailFile;
}
