import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Spinner } from "../stage/kit/parts/Spinner";
import { Collapse } from "../stage/kit/motion/Collapse";
import { States } from "../stage/kit/motion/States";
import type { Act } from "../stage/kit/act";
import { Stage } from "../stage/kit/stage";
import { Bar, Window } from "../stage/kit/window";
import { meta } from "./meta";
import "./demos.css";
import { Card, Key, Record } from "./parts";

// Asks before it changes a file. Beats: the agent says what it's about to do;
// the app's real approval card arrives with the change as a diff; the cursor
// applies it; the button holds its spinner a moment and the card folds into
// the record of what changed, and the agent says so. The thread is pinned
// to its foot, as chats are, so the earlier turns come down as the card
// folds. Plays once; the still is the card waiting.
//
// Real strings: the agent's line, the card's title, the diff, the choices,
// the record.

const DIFF: { text: string; add?: boolean }[] = [
  { text: "## Week 6" },
  { text: "Mon 3 pm  C241 review: induction", add: true },
  { text: "Wed 3 pm  Practice test, timed", add: true },
  { text: "Fri 3 pm  Go over what I missed", add: true },
];

type S = { card: boolean; busy: boolean; done: boolean };
const initial: S = { card: false, busy: false, done: false };
const poster: S = { card: true, busy: false, done: false };

async function script(a: Act<S>) {
  await a.wait(600);
  a.mark("card");
  a.put({ card: true });
  await a.wait(1600);
  await a.move("apply");
  await a.click("apply");
  a.mark("apply");
  a.put({ busy: true });
  await a.wait(700);
  a.put({ card: false, done: true });
  // The hand drifts off the button it pressed, out of the thread's way.
  void a.move(a.layout === "wide" ? { x: 610, y: 408 } : { x: 320, y: 332 }, { duration: 900 });
  await a.wait(3200);
}

const approveSize = meta.approve.size;

export default function ApproveDemo() {
  return (
    <Stage {...approveSize} fill initial={initial} poster={poster} script={script} play="once" cursor={{ at: { wide: { x: 600, y: 410 }, compact: { x: 320, y: 340 } }, style: "real", idle: 1800 }} className="ph-look dm-approve">
      {(s, _rect, layout) => (
        <Window className="dm-win">
          <div className="dm-thread">
            <div className="dm-row-end">
              <div className="ph-bubble">Plan my week around the C241 test</div>
            </div>
            <div className="dm-past">
              <Bar w="92%" h={7} r={4} tone={2} />
              <Bar w="84%" h={7} r={4} tone={2} />
              <Bar w="61%" h={7} r={4} tone={2} />
            </div>
            <div className="dm-row-end">
              <div className="ph-bubble">Put it in my notes</div>
            </div>
            <p className="ph-answer">I’ll add the plan to your week 6 notes.</p>
            <Collapse open={s.card} reveal="drop" from="below">
              <Card
                icon={Tick02Icon}
                title={
                  <>
                    Ready to change <span className="dm-strong">week6.md</span>
                  </>
                }
                meta={
                  <>
                    <span className="dm-add">+3</span> <span className="dm-del">−0</span>
                  </>
                }
                keys={
                  <>
                    <Key k="Y" target="apply" primary>
                      <States value={s.busy ? "busy" : "idle"} align="start" states={{ idle: "Apply change", busy: <span className="dm-busy">Apply change <Spinner /></span> }} />
                    </Key>
                    <Key k="N">Don’t allow</Key>
                  </>
                }
              >
                <div className="ph-well dm-diff">
                  {DIFF.map((l) => (
                    <div key={l.text} className="dm-diff__line" data-add={l.add || undefined}>
                      <span className="dm-diff__sign">{l.add ? "+" : " "}</span>
                      {layout === "compact" ? l.text.replace(/ {2}/, " ") : l.text}
                    </div>
                  ))}
                </div>
              </Card>
            </Collapse>
            <Collapse open={s.done}>
              <Record>
                Changed week6.md <span className="dm-add">+3</span>
              </Record>
            </Collapse>
            <Collapse open={s.done}>
              <p className="ph-answer">Done. Week 6 now has three study blocks before the test.</p>
            </Collapse>
          </div>
        </Window>
      )}
    </Stage>
  );
}
