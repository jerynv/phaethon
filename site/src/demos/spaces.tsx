import { Key01Icon } from "@hugeicons/core-free-icons";
import { Collapse } from "../stage/kit/motion/Collapse";
import { Stream } from "../stage/kit/motion/Stream";
import type { Act } from "../stage/kit/act";
import { Stage } from "../stage/kit/stage";
import { Bar, Window } from "../stage/kit/window";
import { meta } from "./meta";
import { Card, Key, Record, Sidebar } from "./parts";
import "./demos.css";

// Spaces. Beats: a question in the School space; the agent needs something
// from Work, so it stops and asks (the app's real access card); the cursor
// allows it once; the card folds into the line the app leaves behind, and
// the answer, which uses what it was allowed to read, streams in. Plays
// once; the still is the ask.
//
// Real strings: the space, the question, the card's title and choices, the
// record, the answer.

const Q = "Plan my week around the C241 test";
const A = "You work Tuesday and Thursday evenings, so C241 review goes on Monday, Wednesday and Friday afternoons, with a timed practice test on Wednesday.";
const WORDS = A.split(" ").length;

type S = { sent: boolean; ask: boolean; allowed: boolean; words: number };
const initial: S = { sent: false, ask: false, allowed: false, words: 0 };
const poster: S = { sent: true, ask: true, allowed: false, words: 0 };

async function script(a: Act<S>) {
  await a.wait(500);
  a.put({ sent: true });
  await a.wait(900);
  a.mark("ask");
  a.put({ ask: true });
  await a.wait(1300);
  await a.move("once");
  await a.click("once");
  a.mark("allow");
  a.put({ ask: false, allowed: true });
  // The hand drifts off the button it pressed, out of the answer's way.
  void a.move(a.layout === "wide" ? { x: 600, y: 404 } : { x: 310, y: 330 }, { duration: 900 });
  await a.wait(500);
  for (let i = 1; i <= WORDS; i++) {
    a.put({ words: i });
    await a.wait(45);
  }
  await a.wait(3000);
}

const spacesSize = meta.spaces.size;

export default function SpacesDemo() {
  return (
    <Stage {...spacesSize} fill initial={initial} poster={poster} script={script} play="once" cursor={{ at: { wide: { x: 560, y: 420 }, compact: { x: 300, y: 340 } }, style: "real", idle: 1800 }} className="ph-look dm-spaces">
      {(s, _rect, layout) => (
        <Window className="dm-win" sidebar={layout === "wide" ? <Sidebar space="School" open="Plan my week around the C241 test" /> : undefined} sidebarWidth={188}>
          <div className="dm-thread">
            <div className="dm-past">
              <Bar w={190} h={30} r={15} tone={1} className="dm-past__q" />
              <Bar w="88%" h={7} r={4} tone={2} />
              <Bar w="64%" h={7} r={4} tone={2} />
            </div>
            <Collapse open={s.sent} reveal="drop" from="below">
              <div className="dm-row-end">
                <div className="ph-bubble">{Q}</div>
              </div>
            </Collapse>
            <Collapse open={s.ask} reveal="drop" from="below">
              <Card
                icon={Key01Icon}
                title={
                  <>
                    Wants to read <span className="dm-strong">Work / shifts.md</span>
                  </>
                }
                meta={layout === "wide" ? "Read only" : undefined}
                keys={
                  <>
                    <Key k="Y" target="once" primary>
                      Allow once
                    </Key>
                    <Key k="A">Always allow</Key>
                    {layout === "wide" ? <Key k="N">Don’t allow</Key> : null}
                  </>
                }
              >
                <div className="ph-well">To fit study time around your shifts.</div>
              </Card>
            </Collapse>
            <Collapse open={s.allowed}>
              <Record icon={Key01Icon}>Allowed once to read Work / shifts.md</Record>
            </Collapse>
            <Collapse open={s.allowed}>
              <Stream className="ph-answer" text={A} count={s.words} />
            </Collapse>
          </div>
        </Window>
      )}
    </Stage>
  );
}
