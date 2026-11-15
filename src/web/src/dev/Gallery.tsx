import { useState } from "react";
import { ART_PALETTES, ArtCanvas, ArtFrame, ArtTile, DotMatrix } from "@/components/art";
import { BrandMark } from "@/components/brand-mark";
import { Icon, IconProvider } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { KeyAction, KeyActions } from "@/components/ui/key-actions";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { BarLegend, StackedBar } from "@/components/ui/stacked-bar";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { Step, StepList, ThoughtToggle, ToolSummary } from "@/components/ui/step-list";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { ToggleRow } from "@/components/ui/toggle-row";

/**
 * Every v2 primitive on one page, in both themes (`#gallery`, dev builds
 * only). It is the visual check for docs/UI-REBUILD.md and a copy-from
 * reference for the screens. Data here is invented.
 */

const SEGMENTS = [
  { label: "Problem sets", value: 2648 },
  { label: "Reading", value: 174 },
  { label: "Lectures", value: 143 },
  { label: "Review", value: 39 },
  { label: "Other", value: 4 },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {children}
    </section>
  );
}

function Welcome() {
  return (
    <div className="relative flex flex-col items-center gap-6 overflow-hidden rounded-panel border bg-background px-10 pt-16 pb-10">
      <DotMatrix seed="welcome" />
      <BrandMark className="size-6 text-foreground" />
      <h1 className="font-normal text-2xl tracking-heading">Where should we begin?</h1>
      <div className="w-full max-w-(--chat-max-width) rounded-card border bg-card shadow-card">
        <div className="px-4 pt-3.5 pb-10 text-base text-placeholder">Ask anything…</div>
        <div className="flex items-center gap-2 px-3 pb-3">
          <Button variant="outline" size="icon-sm" aria-label="Attach">
            <Icon icon={icons.add} />
          </Button>
          <Button variant="secondary" size="sm" shape="rect">
            <Icon icon={icons.webSearch} />
            Search the web
          </Button>
          <span className="ml-auto flex items-center gap-1 text-muted-foreground text-sm">
            <Icon icon={icons.model} className="size-3.5" /> Sonnet
            <Icon icon={icons.chevronDown} className="size-3.5" />
          </span>
          <Button size="icon-sm" shape="pill" aria-label="Send">
            <Icon icon={icons.send} />
          </Button>
        </div>
      </div>
      <div className="grid w-full max-w-(--chat-max-width) grid-cols-3 gap-3">
        {[
          { icon: icons.create, title: "Create", sub: "Notes, plans, flashcards" },
          { icon: icons.find, title: "Find", sub: "Answers in your files" },
          { icon: icons.research, title: "Research", sub: "Sources and the web" },
        ].map((a) => (
          <Card key={a.title} variant="interactive" render={<button type="button" />} className="items-start gap-5 p-4 text-left">
            <Icon icon={a.icon} className="size-5 text-muted-foreground" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-sm">{a.title}</span>
              <span className="text-muted-foreground text-sm">{a.sub}</span>
            </span>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Panel() {
  const [range, setRange] = useState("1w");
  const [mode, setMode] = useState("pending");
  const [t1, setT1] = useState(true);
  const [t2, setT2] = useState(false);
  const [thought, setThought] = useState(true);
  const [tools, setTools] = useState(true);
  return (
    <div className="grid grid-cols-2 gap-8">
      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Connect device</Button>
          <Button variant="outline">Close</Button>
          <Button variant="accent">Upgrade</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button pending>Saving</Button>
          <Button size="sm" shape="rect">
            Save
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="More">
            <Icon icon={icons.more} />
          </Button>
        </div>
      </Section>
      <Section title="Tabs and segmented controls">
        <div className="flex flex-col items-start gap-3">
          <Tabs value={mode} onValueChange={(v) => setMode(v as string)}>
            <TabsList>
              <TabsTab value="pending">Pending</TabsTab>
              <TabsTab value="dismissed">Dismissed</TabsTab>
              <TabsTab value="resolved">Resolved</TabsTab>
            </TabsList>
          </Tabs>
          <Tabs value={mode} onValueChange={(v) => setMode(v as string)}>
            <TabsList variant="pill">
              <TabsTab value="pending">
                <Icon icon={icons.chat} />
                Chat
              </TabsTab>
              <TabsTab value="dismissed">
                <Icon icon={icons.study} />
                Study
              </TabsTab>
              <TabsTab value="resolved">
                <Icon icon={icons.plan} />
                Plan
              </TabsTab>
            </TabsList>
          </Tabs>
          <Tabs value={mode} onValueChange={(v) => setMode(v as string)} className="w-full">
            <TabsList variant="underline" className="w-full justify-start">
              <TabsTab value="pending">Crawl links</TabsTab>
              <TabsTab value="dismissed">Individual</TabsTab>
            </TabsList>
          </Tabs>
          <div className="flex gap-3">
            <SegmentedControl value={range} onValueChange={setRange} aria-label="Range">
              {["1d", "1w", "1m", "3m"].map((r) => (
                <SegmentedControlItem key={r} value={r}>
                  {r.toUpperCase()}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <SegmentedControl value={range} onValueChange={setRange} variant="outline" aria-label="Range">
              {["1d", "1w", "1m", "3m"].map((r) => (
                <SegmentedControlItem key={r} value={r}>
                  {r.toUpperCase()}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </div>
      </Section>
      <Section title="Statistics">
        <Card>
          <CardHeader>
            <CardTitle>Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <StatGrid>
              <StatTile label="Cards reviewed" value="3,008" />
              <StatTile label="Due today" value="97" delta={-4} />
              <StatTile label="Average" value="88.4" unit="%" delta={2.1} />
              <StatTile label="Streak" value="12" unit="days" />
            </StatGrid>
          </CardContent>
        </Card>
      </Section>
      <Section title="Stacked bar and legend">
        <Card>
          <CardHeader>
            <CardTitle className="font-normal text-sm">Study time by kind · past 7 days</CardTitle>
            <CardAction>
              <Button variant="ghost" size="icon-xs" aria-label="More">
                <Icon icon={icons.more} />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <StackedBar segments={SEGMENTS} />
            <BarLegend segments={SEGMENTS} />
          </CardContent>
          <CardFooter className="justify-between">
            <span className="text-muted-foreground text-sm">Save to plan</span>
            <Button size="xs" shape="rect">
              <Icon icon={icons.add} /> Save
            </Button>
          </CardFooter>
        </Card>
      </Section>
      <Section title="Toggle rows">
        <Card>
          <CardContent className="gap-0 divide-y py-1">
            <ToggleRow title="Show technical details" description="Tool names, raw paths and output under each step." checked={t1} onCheckedChange={setT1} />
            <ToggleRow title="Compact progress" description="One summary line while a reply works." checked={t2} onCheckedChange={setT2} />
            <ToggleRow icon={<Icon icon={icons.webSearch} />} title="Web search" checked={t1} onCheckedChange={setT1} />
          </CardContent>
        </Card>
      </Section>
      <Section title="Approval">
        <Card className="gap-3 p-3">
          <div className="flex items-center gap-2.5 px-2 pt-1 text-primary">
            <Icon icon={icons.done} className="size-5" />
            <span className="text-base">Draft is ready</span>
          </div>
          <div className="flex flex-col gap-4 rounded-xl border bg-well p-4 text-base">
            <p>Rewrote notes/week6.md with the definitions in math notation and the composition rule.</p>
            <div className="flex gap-2">
              <Button size="sm" shape="rect">
                Edit
              </Button>
              <Button size="sm" shape="rect" variant="outline">
                View changes
              </Button>
            </div>
          </div>
          <KeyActions>
            <KeyAction shortcut="Y">Accept</KeyAction>
            <KeyAction shortcut="N">Reject</KeyAction>
          </KeyActions>
        </Card>
      </Section>
      <Section title="Thought steps">
        <div className="flex flex-col items-start rounded-card border bg-background p-5">
          <ThoughtToggle state="done" label="Thought 12s" open={thought} onOpenChange={setThought} />
          <StepList open={thought} className="w-full">
            <Step>Reading week 6 notes</Step>
            <Step>Found 3 definitions</Step>
            <Step>Checking the composition rule</Step>
            <Step state="active">Building the summary…</Step>
          </StepList>
          <ThoughtToggle className="mt-4" state="thinking" label="Thinking…" open={false} onOpenChange={() => {}} />
        </div>
      </Section>
      <Section title="Tool summary">
        <div className="rounded-card border bg-background p-5">
          <ToolSummary summary="18 tools, edited 5 files, ran 2 commands" duration="6m 12s" open={tools} onOpenChange={setTools}>
            <StepList variant="icon">
              <Step icon={icons.terminal} tag="script">
                Running command
              </Step>
              <Step icon={icons.task} tag="file">
                Task update
              </Step>
              <Step icon={icons.terminal} detail={<pre className="rounded-xl border bg-code p-3 font-mono text-xs">{'{ "status": "completed" }'}</pre>}>
                Running command
              </Step>
              <Step icon={icons.done}>Done</Step>
            </StepList>
          </ToolSummary>
        </div>
      </Section>
    </div>
  );
}

function ArtRow() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-5 gap-3">
        {ART_PALETTES.map((p) => (
          <ArtCanvas key={p} palette={p} seed="gallery" weave={p === "dawn"} className="h-28 rounded-card" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Card>
          <CardMedia className="h-28">
            <ArtCanvas palette="dawn" seed="pro" weave className="absolute inset-0" />
          </CardMedia>
          <CardHeader>
            <CardTitle>Spring term</CardTitle>
            <CardDescription>Four courses, two exams in the next month.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full">Open the plan</Button>
          </CardContent>
        </Card>
        <ArtFrame palette="meadow" seed="frame" className="h-72">
          <div className="flex flex-col gap-3 p-6">
            <ThoughtToggle state="done" label="Thought 8s" open={false} onOpenChange={() => {}} />
            <p className="text-base">Your strongest week since the term began.</p>
          </div>
        </ArtFrame>
        <div className="col-span-2 flex flex-col gap-3">
          {[
            { p: "sky" as const, t: "Connect a course", s: "Bring in your syllabus, files and dates." },
            { p: "ember" as const, t: "Add your notes", s: "Upload documents and trusted sources." },
          ].map((c) => (
            <Card key={c.t} variant="interactive" className="flex-row items-center gap-5 p-2 pr-6">
              <ArtTile palette={c.p} seed={c.t} className="h-20 w-36" />
              <span className="flex flex-col gap-1">
                <span className="text-lg">{c.t}</span>
                <span className="text-muted-foreground text-sm">{c.s}</span>
              </span>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Gallery() {
  return (
    <IconProvider>
      <div className="h-full overflow-auto bg-canvas p-(--frame-inset)">
        <div className="relative flex flex-col gap-10 rounded-panel border bg-background p-10">
          <DotMatrix />
          <Welcome />
          <Panel />
          <ArtRow />
        </div>
      </div>
    </IconProvider>
  );
}
