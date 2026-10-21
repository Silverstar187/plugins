---
name: statechart
description: "Draw what a user sees as a Mermaid statechart generated from a TLA+ model. States are marked works, still wrong, or fixed, and each bug TLC finds is a numbered path. Use for /statechart, \"show the PM the bug\", or to turn an agreed chart into a TLA+ skeleton."
disable-model-invocation: true
---

# Statechart

A PM, a designer, or a reviewer can judge a chart of what they see. They cannot judge a TLA+ spec. This skill draws the chart from the model, so the chart and the checked model are one object. The reader's rules ("you never see X while Y") become invariants. TLC finds every path that breaks one. The chart shows each as a numbered path in the reader's words.

## Pick the direction

- **A model exists, or the code is concrete enough to model.** Go model to chart. If the project has a formal verification skill, start from its spec. A spec written for one property may not hold what the reader sees. Add those variables and keep its old invariants passing. A new spec follows the "true to the code" rules in [create-formal-verification-skill](../create-formal-verification-skill/SKILL.md).
- **No model, and the reader should agree on the behavior before code exists or changes.** Go chart to model.

## Setup

- Java 11 or later and `tla2tools.jar` from the [TLA+ releases](https://github.com/tlaplus/tlaplus/releases). Set `TLA2TOOLS` to the jar's path.
- Node. The scripts in `scripts/` next to this file have no dependencies.
- To render, `npx -y @mermaid-js/mermaid-cli -i chart.mmd -o chart.png -s 2`.

Run TLC like this in every step below. `-deadlock` is needed because a UI at rest has nothing left to do, which TLC would report as a deadlock. With `-continue`, TLC keeps going past a broken rule and exits 0, so read its output, not its exit code.

```bash
tlc() { java -cp "$TLA2TOOLS" tlc2.TLC -metadir "$(mktemp -d)" -deadlock -continue "$@"; }
```

## Model to chart

1. **Name the reader's states.** Write what the reader sees and does, in their words. Each name passes one test. The reader can point at it on their screen. Start coarse. Split a state only when the split separates two bugs. On one model, coarse names found the same bugs as fine names with a third of the states.

2. **Write the reader's rules as invariants.** One sentence the reader agrees to is one invariant, with the sentence as its comment. For "once everything settles", define `Settled == ~ENABLED System`, where `System` is the disjunction of the actions the reader does not take. Never weaken a rule to make the chart pass. A broken rule is the finding.

3. **Write the mapping module.** It is an ES module that `tlc-to-chart.mjs` imports.

   ```js
   export const readerActions = ["EditNote", "OpenApp"];
   // Reader words for one model state. facts.settled is true when only reader actions can happen.
   export function state(v, facts) {}
   // Edge label in reader words. Return "" to hide a step.
   export function step(action, before, after) {}
   // Why a bad state is bad, in code terms.
   export function cause(v, facts, invariant) {}
   // Developer words for one model state. Needed only for --view developer or layered.
   export function detail(v, facts) {}
   ```

   Counterexamples that break the same rule with the same `cause` are one bug. Two bugs that end on the same screen through different code paths stay apart only if `cause` names the code path, such as "the badge read the cache before the server answered".

4. **Run TLC.** One run dumps the state graph. Then run once per rule, because TLC reports only the first rule a state breaks.

   ```bash
   tlc -dump dot,actionlabels Spec.dot -config Spec.cfg Spec.tla > Spec.out
   for rule in NoStaleBadge NoLostEdit; do
     { grep -v '^INVARIANT' Spec.cfg; echo "INVARIANT $rule"; } > "Spec-$rule.cfg"
     tlc -config "Spec-$rule.cfg" Spec.tla > "Spec-$rule.out"
     echo "$rule: $(grep -c '^Error: Invariant' "Spec-$rule.out") counterexamples"
   done
   ```

   If an open change fixes some of it, model the change as a second spec (`SpecFixed.tla`) and run the same commands on it.

5. **Draw the reader's chart.**

   ```bash
   node scripts/tlc-to-chart.mjs --dot Spec.dot --map map.mjs \
     --traces Spec-NoStaleBadge.out --traces Spec-NoLostEdit.out \
     --fixed-dot SpecFixed.dot \
     --fixed-traces SpecFixed-NoStaleBadge.out --fixed-traces SpecFixed-NoLostEdit.out \
     --cover --highlight 1 --title "Offline editing today" \
     --out chart.mmd --story stories.md --summary summary.json
   ```

   Leave out the `--fixed-*` flags when there is no fix. `--cover` keeps the shortest path to each settled reader state plus every bug path. Without it, every edge shows, which was four times as many on one model. `--highlight N` numbers the steps of bug N. Draw one chart per bug for the hand-off, and one with `--highlight 0` for the overview.

   Render each chart and open the PNG. Every label is in the reader's words, the legend is there, and the numbered path reads in order. If a label reads like code, fix `state` or `step` and redraw.

6. **Show one bug's mechanism.** `--view developer --path-only --highlight N` draws bug N through the `detail` states. Do not draw a whole developer chart. On one model it had twelve times the states of the reader's chart. `--view layered` puts the developer states inside the reader states, for a reviewer who wants both on one page.

7. **Reproduce every red path in the real code.** The model can be wrong. Replay each bug's story from `stories.md` as a test or a live repro against the real code, one step per model action. A bug you cannot reproduce is a modeling error until shown otherwise. Fix the model, not the rule. Report which bugs reproduced.

## Chart to model

1. **Write the chart** in Mermaid `stateDiagram-v2`. Split a top-level composite with `--` into regions. Each region is one variable. Each transition label is one action, and regions with the same label move together. Write each rule as a comment line.

   ```
   %% never NeverSyncedWhileOffline: Offline & Synced -- You never see "Synced" while you are offline.
   ```

   Each name in a `never` line is a state, or a composite that stands for every state inside it. The names must come from different regions. The chart cannot hold history states. Draw "comes back to where it was" as an edge to that state.

2. **Generate the skeleton.** `node scripts/chart-to-tla.mjs chart.mmd --module Sync` writes `Sync.tla`, `Sync.cfg`, and `Sync.map.mjs`.

3. **Check the agreed chart.** Run step 4 of model to chart on `Sync`, then draw and compare.

   ```bash
   node scripts/tlc-to-chart.mjs --dot Sync.dot --map Sync.map.mjs --traces Sync-NeverSyncedWhileOffline.out --highlight 0 --out drawn.mmd
   node scripts/compare-charts.mjs chart.mmd drawn.mmd
   ```

   `compare-charts.mjs` prints `same` when the drawn chart has the same states and transitions. A broken rule here is a design bug in the agreed chart, found before any code. Take it back to the reader.

4. **Add the real code.** Add guards and variables from the code to `Sync.tla`, and repeat step 3. Each difference `compare-charts.mjs` prints is a place where the code does not do what the chart says. Give each one to the reader to decide. It is a bug in the code or a correction to the chart.

## Read the chart

- Gray states work today. Red states are still wrong, because the checks still reach a first bad state there with the fix in. Green states are fixed by the open change. Without `--fixed-*`, every bad state is red.
- A thick blue border and numbered labels mark the highlighted bug. Mermaid state diagrams cannot color an edge.
- An edge shows its two most common labels. "or …" means there are more.
- `stories.md` has one entry per bug. It gives the rule, the cause, the shortest path in reader steps, how many counterexamples end there, and what the fixed model does instead.
- `summary.json` has the counts behind the chart. Quote it, not an estimate.

## Hand off

Give the reader the PNG of each chart and its Mermaid source. Add one line per bug with the rule it breaks, the reader's steps, whether it reproduced, and whether the open change fixes it. Attach `stories.md` and the commands that regenerate everything. Say what the model leaves out.
