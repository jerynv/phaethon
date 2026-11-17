import anthropic from "@/assets/providers/anthropic.svg";
import claude from "@/assets/providers/claude.svg";
import ollama from "@/assets/providers/ollama.svg";
import openai from "@/assets/providers/openai.svg";
import { Icon } from "@/components/icon";
import { AiBrain01Icon, ArrowDown01Icon, ArrowUp02Icon, Attachment01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Popover } from "../stage/kit/motion/Popover";
import { Roll } from "../stage/kit/motion/Roll";
import type { Act } from "../stage/kit/act";
import { Stage } from "../stage/kit/stage";
import { Bar, Window } from "../stage/kit/window";
import { meta } from "./meta";
import "./demos.css";

// Bring your own AI. Beats: the composer's model button opens the app's
// model picker (a rail of providers, the models under each); the cursor
// goes past Claude and GPT to a model running on this computer through
// Ollama and picks it; the button rolls to its name and a question is typed.
// Plays once; the still is the picker open on that model.
//
// Real strings: the model names, the provider headings, the question.

type Model = { id: string; name: string; group: string };
const GROUPS: { id: string; name: string; logo: string; mono?: boolean }[] = [
  { id: "anthropic", name: "Anthropic", logo: anthropic, mono: true },
  { id: "openai", name: "OpenAI", logo: openai, mono: true },
  { id: "ollama", name: "Ollama", logo: ollama, mono: true },
  { id: "claude-cli", name: "Claude Code", logo: claude },
];
const MODELS: Model[] = [
  { id: "opus", name: "Claude Opus 5.5", group: "anthropic" },
  { id: "sonnet", name: "Claude Sonnet 5.5", group: "anthropic" },
  { id: "gpt", name: "GPT-5", group: "openai" },
  { id: "llama", name: "llama3.3", group: "ollama" },
];
const Q = "Summarize today’s lecture notes";

type S = { open: boolean; pick: "opus" | "llama"; draft: string };
const initial: S = { open: false, pick: "opus", draft: "" };
const poster: S = { open: true, pick: "opus", draft: "" };

async function script(a: Act<S>) {
  await a.wait(700);
  await a.move("chip");
  await a.click("chip");
  a.mark("open");
  a.put({ open: true });
  await a.wait(700);
  await a.move("m-sonnet", { duration: 380 });
  await a.move("m-llama", { duration: 520 });
  await a.wait(350);
  await a.click("m-llama");
  a.mark("pick");
  a.put({ pick: "llama" });
  await a.wait(160);
  a.put({ open: false });
  await a.wait(700);
  await a.move("input");
  await a.type("draft", Q, { interval: 40 });
  await a.wait(3000);
}

function Logo({ src, mono }: { src: string; mono?: boolean }) {
  return <img alt="" src={src} width={16} height={16} draggable={false} className={mono ? "dm-logo dark:invert" : "dm-logo"} />;
}

const modelsSize = meta.models.size;

export default function ModelsDemo() {
  return (
    <Stage {...modelsSize} fill initial={initial} poster={poster} hover={["m-llama"]} script={script} play="once" cursor={{ at: { wide: { x: 360, y: 420 }, compact: { x: 200, y: 340 } }, style: "real", idle: 1800 }} className="ph-look dm-models">
      {(s) => {
        const pick = MODELS.find((m) => m.id === s.pick)!;
        const group = GROUPS.find((g) => g.id === pick.group)!;
        return (
          <Window className="dm-win">
            <div className="dm-thread">
              <div className="dm-past">
                <Bar w={210} h={30} r={15} tone={1} className="dm-past__q" />
                <Bar w="86%" h={7} r={4} tone={2} />
                <Bar w="70%" h={7} r={4} tone={2} />
                <Bar w="44%" h={7} r={4} tone={2} />
                <Bar w={160} h={30} r={15} tone={1} className="dm-past__q dm-past__gap" />
                <Bar w="90%" h={7} r={4} tone={2} />
                <Bar w="78%" h={7} r={4} tone={2} />
                <Bar w="83%" h={7} r={4} tone={2} />
                <Bar w="36%" h={7} r={4} tone={2} />
              </div>
            </div>
            <div className="dm-composer">
              <div className="dm-composer__input" data-target="input" data-cursor="ibeam">
                <span className="dm-composer__ph" data-off={s.draft ? true : undefined}>
                  Ask anything…
                </span>
                <span className="dm-composer__text">{s.draft}</span>
              </div>
              <div className="dm-composer__foot">
                <Icon icon={Attachment01Icon} className="dm-composer__icon" />
                <span className="dm-composer__spacer" />
                <span className="dm-chip" data-target="chip" data-cursor="pointer" data-open={s.open || undefined}>
                  <Logo src={group.logo} mono={group.mono} />
                  <Roll variant="fade">{pick.name}</Roll>
                  <Icon icon={ArrowDown01Icon} className="dm-composer__icon" />
                </span>
                <span className="dm-send" data-on={s.draft ? true : undefined}>
                  <Icon icon={ArrowUp02Icon} />
                </span>
              </div>
              <Popover show={s.open} origin="bottom right" className="dm-picker">
                <div className="dm-picker__rail">
                  <span className="dm-picker__all" data-on>
                    <Icon icon={AiBrain01Icon} />
                  </span>
                  {GROUPS.map((g) => (
                    <span key={g.id} className="dm-picker__railbtn">
                      <Logo src={g.logo} mono={g.mono} />
                    </span>
                  ))}
                </div>
                <div className="dm-picker__list">
                  {GROUPS.filter((g) => g.id !== "claude-cli").map((g) => (
                    <div key={g.id} className="dm-picker__group">
                      <div className="dm-picker__head">{g.name}</div>
                      {MODELS.filter((m) => m.group === g.id).map((m) => (
                        <div key={m.id} className="dm-picker__row" data-target={`m-${m.id}`} data-cursor="pointer" data-on={m.id === s.pick || undefined}>
                          <Logo src={g.logo} mono={g.mono} />
                          <span className="dm-picker__name">{m.name}</span>
                          <Icon icon={Tick02Icon} className="dm-picker__tick" />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </Popover>
            </div>
          </Window>
        );
      }}
    </Stage>
  );
}
