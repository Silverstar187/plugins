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
- Node. The scripts in `scripts/` next to this file have no dependencies. `node --test scripts/test/statechart.test.mjs` checks them, and runs the TLC tests too when `TLA2TOOLS` is set.
- To render, `npx -y @mermaid-js/mermaid-cli -i chart.mmd -o chart.png -s 2`.

Run TLC like this in every step below. `-deadlock` is needed because a UI at rest has nothing left to do, which TLC would report as a deadlock.

```bash
tlc() { java -cp "$TLA2TOOLS" tlc2.TLC -metadir "$(mktemp -d)" -deadlock -continue "$@"; }
```

With `-continue`, TLC exits 0 after a broken rule, and its output still ends with "Model checking completed. No error has been found." So count the `Error: Invariant` lines. A nonzero exit, or no "Model checking completed" line, means the run failed or stopped early. Read the output to find why. `tlc-to-chart.mjs` refuses such a file.

## Model to chart

1. **Name the reader's states.** Write what the reader sees and does, in their words. Each name passes one test. The reader can point at it on their screen, or it names a fact they care about. When the harm is off screen, such as a second charge while the screen still says "Paying", put the fact in the name ("Paying, charged twice"). Otherwise the bug's path looks like a normal path. Start coarse. Split a state only when the split separates two bugs. On one model, coarse names found the same bugs as fine names with a third of the states.

2. **Write the reader's rules as invariants.** One sentence the reader agrees to is one invariant, with the sentence as its comment. For "once everything settles", define `Settled == ~ENABLED System`, where `System` is the disjunction of the actions the reader does not take. Never weaken a rule to make the chart pass. A broken rule is the finding.

3. **Write the mapping module.** It is an ES module that `tlc-to-chart.mjs` imports.

   ```js
   // TLA+ actions the reader takes. facts.settled and --cover need them.
   export const readerActions = ["EditNote", "OpenApp"];
   // Reader words for one model state.
   export function state(v, facts) {}
   // Edge label in reader words.
   export function step(action, before, after) {}
   // Why a bad state is bad, in code terms.
   export function cause(v, facts, invariant) {}
   // Developer words for one model state. Needed only for --view developer or layered.
   export function detail(v, facts) {}
   ```

   - `v`, `before`, and `after` map each variable name to its value. Strings, numbers, and booleans become their JavaScript kind. Sequences, tuples, and sets become arrays, indexed from 0. Records become objects. A function `(a :> 1 @@ b :> 2)` becomes an object keyed by its domain.
   - `facts.enabled` is the set of actions the state enables, including steps that change no variable. `facts.settled` is true when every enabled action is a reader action, so nothing else happens until the reader acts.
   - `invariant` is the name of the broken rule.
   - A step that leaves the reader in the same state is not drawn, whatever `step` returns. A reader action is the exception on a bug path, because the reader did it. When `step` returns `""`, the edge has no label in the overview, and a numbered bug step shows the TLA+ action name.

   Counterexamples that break the same rule with the same `cause` are one bug. Two bugs that end on the same screen through different code paths stay apart only if `cause` names the code path, such as "the badge read the cache before the server answered".

4. **Run TLC.** Keep the rules out of `Spec.cfg`. TLC reports only the first rule a state breaks, so each rule gets its own run, with one `INVARIANT` line added to `Spec.cfg`. One more run dumps the state graph.

   ```bash
   tlc -dump dot,actionlabels Spec.dot -config Spec.cfg Spec.tla > Spec.out
   for rule in TypeOK NoStaleBadge NoLostEdit; do
     { cat Spec.cfg; echo; echo "INVARIANT $rule"; } > "Spec-$rule.cfg"
     tlc -config "Spec-$rule.cfg" Spec.tla > "Spec-$rule.out"
     echo "$rule: exit $?, $(grep -c '^Error: Invariant' "Spec-$rule.out") counterexamples"
   done
   ```

   If an open change fixes some of it, model the change as a second spec, `SpecFixed.tla` with `MODULE SpecFixed`. Copy `Spec.cfg` to `SpecFixed.cfg`, and run the same commands with `SpecFixed` in place of `Spec`.

5. **Draw the reader's chart.**

   ```bash
   node scripts/tlc-to-chart.mjs --dot Spec.dot --map map.mjs \
     --traces Spec-NoStaleBadge.out --traces Spec-NoLostEdit.out \
     --fixed-dot SpecFixed.dot \
     --fixed-traces SpecFixed-NoStaleBadge.out --fixed-traces SpecFixed-NoLostEdit.out \
     --cover --highlight 1 --title "Offline editing today" \
     --out chart.mmd --story stories.md --summary summary.json
   ```

   Leave out the `--fixed-*` flags when there is no fix. `--cover` keeps the shortest path to each settled reader state, plus every bug path. Without it, every edge shows, which was four times as many on one model. `--highlight N` numbers the steps of bug N. Bugs are numbered by fewest reader steps, then fewest model steps. Bugs that only the fixed model has come after the current bugs. Run once with `--highlight 0` to get the overview and the numbers in `summary.json`. Then draw one chart per bug for the hand-off.

   Render each chart and open the PNG. Every label is in the reader's words, the legend is there, and the numbered path reads in order. If a label reads like code, fix `state` or `step` and draw again.

6. **Show one bug's mechanism.** Add `--view developer --path-only --highlight N` to the step 5 command to draw bug N through the `detail` states. Use `--view layered --path-only --highlight N` to put the developer states inside the reader states, for a reviewer who wants both on one page. Always use `--path-only` with these views. Without it, one model gave twelve times the states of the reader's chart.

7. **Reproduce every red path in the real code.** The model can be wrong. Replay each bug's story from `stories.md` as a test or a live repro against the real code, one step per model action. A bug you cannot reproduce is a modeling error until shown otherwise. Fix the model, not the rule. Report which bugs reproduced.

## Chart to model

1. **Write the chart** in Mermaid `stateDiagram-v2`. To make parallel regions, split one top-level composite with `--`. Wrap each part in a named composite, such as `state Connection { ... }`, to name its region and its variable. Each region is one variable. Each transition label is one action. An action can happen when at least one region can take that label. Every region that can take it moves, and the other regions stay where they are. An unlabeled transition is its own action. Write each rule as a comment line.

   ```
   %% never NeverSyncedWhileOffline: Offline & Synced -- You never see "Synced" while you are offline.
   ```

   Each name in a `never` line is a state caption, or a composite that stands for every state inside it. The names must come from different regions. Each state needs its own caption. The parser refuses what it cannot model: final states (`X --> [*]`), choice, fork, and history states, regions below the top level, and a `--` outside a composite. Draw "the app closes" as an edge to the state the reader sees next, and "comes back to where it was" as an edge to that state.

2. **Generate the skeleton.** `node scripts/chart-to-tla.mjs chart.mmd --module Sync` writes `Sync.tla`, `Sync.cfg`, and `Sync.map.mjs`, and prints the rules. `Sync.cfg` names no rule, and a comment in it lists them. Fill in `readerActions` in `Sync.map.mjs` with the actions the reader takes.

3. **Check the agreed chart.** Run step 4 of model to chart on `Sync` with the rules it printed. Then draw the chart for comparison and compare.

   ```bash
   node scripts/tlc-to-chart.mjs --dot Sync.dot --map Sync.map.mjs --traces Sync-NeverSyncedWhileOffline.out \
     --highlight 0 --all-labels --out drawn.mmd
   node scripts/compare-charts.mjs chart.mmd drawn.mmd
   ```

   Draw the comparison chart with `--highlight 0 --all-labels`, without `--cover` or `--fixed-dot`. `compare-charts.mjs` refuses other charts and exits 2. It compares the combined machine of all regions, so a guard that blocks a step in only some combinations of region states shows as a difference. It prints `same` and exits 0 when the states, start states, and transitions match, and exits 1 when they differ. It also lists region states that the agreed chart's own steps never reach. A broken rule here is a design bug in the agreed chart, found before any code. Take it back to the reader.

4. **Add the real code.** Add guards and variables from the code to `Sync.tla`, and repeat step 3. Each difference `compare-charts.mjs` prints is a place where the code does not do what the chart says. Give each one to the reader to decide. It is a bug in the code or a correction to the chart.

## Read the chart

- Gray states work today. Red states are still wrong with the fix in. Green states are fixed by the open change, or new with it. Without `--fixed-*`, every bad state is red.
- A state is bad when it breaks a rule, or when every path from the start to it passes a state that breaks one. What the reader sees after a bug is part of that bug.
- A thick blue border and numbered labels mark the highlighted bug. Mermaid state diagrams cannot color an edge.
- An edge labeled "with the fix" leaves the state before the step that the fix changes, and ends where the fixed model goes instead. An edge labeled "blocked by the fix" loops on the state where the fix stops that step. An edge labeled "(with the fix)" exists only in the fixed model.
- An edge shows its two most common labels. "or …" means there are more. `--all-labels` shows them all.
- `stories.md` has one entry per bug. It gives the rule, the cause, the shortest path in reader steps, how many counterexamples end there, and what the fixed model does instead. A bug that only the fixed model has is marked "New with the fix".
- `summary.json` has the counts behind the chart. Quote it, not an estimate. Its counterexample counts are lower than the counts from the step 4 loop. TLC reports each bad state, including the bad states after the first one on a path. `summary.json` counts only the paths that end on their first bad state.

## Hand off

Give the reader the PNG of each chart and its Mermaid source. Add one line per bug with the rule it breaks, the reader's steps, whether it reproduced, and whether the open change fixes it. Attach `stories.md` and the commands that regenerate everything. Say what the model leaves out.
