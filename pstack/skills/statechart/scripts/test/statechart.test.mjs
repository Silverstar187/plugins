// node --test scripts/test/statechart.test.mjs
// Set TLA2TOOLS (path to tla2tools.jar) and JAVA (java binary, default "java") to run the TLC tests too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTlcOutput, parseDot, parseMermaid, parseTraces, parseValue } from "../lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = dirname(here);
const fixture = (name) => readFileSync(join(here, name), "utf8");
const edges = (r) => r.transitions.map((t) => `${t.from} -> ${t.to} : ${t.label}`).sort();
const node = (script, args, cwd) => spawnSync(process.execPath, [join(scripts, script), ...args], { cwd, encoding: "utf8" });

test("a transition on a composite leaves from every state inside it", () => {
	const { regions } = parseMermaid(fixture("upload.mmd"));
	const main = regions.Main;
	assert.deepEqual([...main.states].sort(), ["Nothing chosen", "Upload failed", "Uploaded", "Uploading.Checking the file", "Uploading.Sending the file"]);
	assert.deepEqual([...main.initial], ["Nothing chosen"]);
	assert.deepEqual(edges(main), [
		"Nothing chosen -> Uploading.Sending the file : you choose a file",
		"Upload failed -> Uploading.Sending the file : you retry",
		"Uploading.Checking the file -> Nothing chosen : you cancel",
		"Uploading.Checking the file -> Upload failed : the network drops",
		"Uploading.Checking the file -> Uploaded : the check passes",
		"Uploading.Sending the file -> Nothing chosen : you cancel",
		"Uploading.Sending the file -> Upload failed : the network drops",
		"Uploading.Sending the file -> Uploading.Checking the file : the last byte arrives",
	]);
});

test("the deepest source wins when a composite and a state inside it share a label", () => {
	const { regions } = parseMermaid(`stateDiagram-v2
  state Form {
    [*] --> Typing
    Typing --> Confirm : you press Escape
    state Confirm
  }
  [*] --> Form
  Form --> Closed : you press Escape
  Confirm --> Closed : you press Escape`);
	assert.deepEqual(edges(regions.Main), ["Form.Confirm -> Closed : you press Escape", "Form.Typing -> Form.Confirm : you press Escape"]);
});

test("a top-level composite split by -- makes one region per part", () => {
	const { regions, nevers } = parseMermaid(fixture("sync.mmd"));
	assert.deepEqual(Object.keys(regions), ["Connection", "Sync badge"]);
	assert.deepEqual(edges(regions["Sync badge"]), [
		"Synced -> Waiting to sync : the network drops",
		"Synced -> Waiting to sync : you edit a note",
		"Waiting to sync -> Synced : the server confirms",
	]);
	assert.deepEqual(nevers, [{ name: "NeverSyncedWhileOffline", states: ["Offline", "Synced"], sentence: 'You never see "Synced" while you are offline.' }]);
});

test("the legend is not part of the machine", () => {
	const { regions } = parseMermaid(`stateDiagram-v2
  state "Legend" as legend {
    state "Works today" as legendWorks
  }
  [*] --> A
  A --> B : go`);
	assert.deepEqual([...regions.Main.states].sort(), ["A", "B"]);
});

test("the parser refuses charts it cannot read", () => {
	assert.throws(() => parseMermaid("stateDiagram-v2\n  state A {\n  [*] --> B"), /unclosed/);
	assert.throws(() => parseMermaid("stateDiagram-v2\n  A ==> B"), /cannot read chart line/);
	assert.throws(() => parseMermaid("stateDiagram-v2\n  state A {\n    B --> C : go\n  }\n  [*] --> A"), /no \[\*\] --> start/);
	assert.throws(
		() => parseMermaid("stateDiagram-v2\n  state A {\n    state B {\n      [*] --> C\n      --\n      [*] --> D\n    }\n    [*] --> B\n  }\n  [*] --> A"),
		/below the top level/,
	);
	assert.throws(() => parseMermaid("stateDiagram-v2\n  [*] --> A\n  A --> [*] : you close the app"), /final state/);
	assert.throws(
		() => parseMermaid('stateDiagram-v2\n  state "Something went wrong" as UploadError\n  state "Something went wrong" as SyncError\n  [*] --> UploadError\n  UploadError --> SyncError : go'),
		/two states have the caption "Something went wrong"/,
	);
});

test("the parser reads class shorthand, repeated descriptions, and states first named inside a composite", () => {
	const { regions } = parseMermaid(`stateDiagram-v2
  classDef wrong fill:#fdd
  N : Nothing chosen
  N : press Upload to start
  [*] --> N
  N:::wrong --> Done : you finish
  Done --> Moving:::wrong
  state A {
    [*] --> X
    X --> Y : go
  }
  Moving --> A : start
  Y --> Z : next
  A --> N : cancel`);
	assert.deepEqual([...regions.Main.states].sort(), ["A.X", "A.Y", "Done", "Moving", "Nothing chosen", "Z"]);
	assert.deepEqual(edges(regions.Main), [
		"A.X -> A.Y : go",
		"A.X -> Nothing chosen : cancel",
		"A.Y -> Nothing chosen : cancel",
		"A.Y -> Z : next",
		"Done -> Moving : ",
		"Moving -> A.X : start",
		"Nothing chosen -> Done : you finish",
	]);
});

test("TLC values, states, graphs, and traces parse", () => {
	assert.deepEqual(parseValue('[a |-> <<1, "x">>, b |-> {TRUE}]'), { a: [1, "x"], b: [true] });
	assert.deepEqual(parseValue('("p" :> 1 @@ "q" :> 2)'), { p: 1, q: 2 });
	const graph = parseDot(`strict digraph DiskGraph {
1 [label="/\\\\ x = 0",style = filled]
2 [label="/\\\\ x = 1"]
1 -> 2 [label="Inc",color="black",fontcolor="black"];
1 -> 2 [label="Inc",color="black",fontcolor="black"];
2 -> 2 [label="Stay"];
}`);
	assert.equal(graph.nodes.get("1").init, true);
	assert.deepEqual(graph.nodes.get("2").vars, { x: 1 });
	assert.deepEqual(graph.edges, [{ from: "1", to: "2", action: "Inc" }]);
	assert.deepEqual(graph.loops, [{ from: "2", to: "2", action: "Stay" }]);
	assert.throws(() => parseDot('strict digraph DiskGraph {\n1 [label="/\\\\ x = 0",style = filled]\n2 [label="/\\\\ x = 1"]\n1 -> 2;\n}'), /no action names/);
	const [trace] = parseTraces(`Error: Invariant Small is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
x = 0

State 2: <Inc line 9, col 8 to line 9, col 20 of module M>
x = 1
`);
	assert.equal(trace.invariant, "Small");
	assert.deepEqual(trace.steps, [{ action: null, vars: { x: 0 } }, { action: "Inc", vars: { x: 1 } }]);
});

const done = "Model checking completed. No error has been found.\n";
const evaluationError = `Error: Invariant NoLost is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
s = "Idle"

State 2: <Lose line 4, col 9 to line 4, col 33 of module F>
s = "Lost"

Error: TLC threw an unexpected exception.
This was probably caused by an error in the spec or model.

Error: The behavior up to this point is:
State 1: <Initial predicate>
s = "Idle"

State 2: <Save line 5, col 9 to line 5, col 35 of module F>
s = "Saving"

3 states generated, 3 distinct states found, 0 states left on queue.
`;

test("a rule broken by a start state is a counterexample of one state", () => {
	const text = `Error: Invariant NeverSyncedWhileOffline is violated by the initial state:
/\\ badge = "Synced"
/\\ conn = "Offline"

${done}`;
	assert.doesNotThrow(() => checkTlcOutput(text, "tlc.out"));
	assert.deepEqual(parseTraces(text), [{ invariant: "NeverSyncedWhileOffline", steps: [{ action: null, vars: { badge: "Synced", conn: "Offline" } }] }]);
});

test("TLC output from a run that failed or stopped early is refused", () => {
	assert.doesNotThrow(() => checkTlcOutput(`Error: Invariant Small is violated.\nError: The behavior up to this point is:\nState 1: <Initial predicate>\nx = 0\n\n${done}`, "ok.out"));
	assert.throws(() => checkTlcOutput("Error: The invariant Nope specified in the configuration file\nis not defined in the specification.\n", "cfg.out"), /cfg\.out: TLC stopped on an error that is not a broken rule/);
	assert.throws(() => checkTlcOutput("Error: Parsing or semantic analysis failed.\n", "parse.out"), /not a broken rule/);
	assert.throws(() => checkTlcOutput(evaluationError, "eval.out"), /TLC threw an unexpected exception/);
	assert.throws(() => checkTlcOutput("Error: Invariant Small is violated.\nError: The behavior up to this point is:\nState 1: <Initial predicate>\nx = 0\n", "stopped.out"), /did not finish/);
	assert.deepEqual(
		parseTraces(evaluationError).map((t) => t.invariant),
		["NoLost", null],
	);
});

test("a step that changes nothing keeps a state unsettled, and a quote in a reader label survives the chart", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(
		join(dir, "save.dot"),
		`strict digraph DiskGraph {
1 [label="/\\\\ s = \\"Idle\\"",style = filled]
2 [label="/\\\\ s = \\"Saving\\""]
1 -> 2 [label="Tap"];
2 -> 2 [label="Retry"];
}`,
	);
	writeFileSync(
		join(dir, "save.map.mjs"),
		`export const readerActions = ["Tap"];
export const state = (v, facts) => (v.s === "Idle" ? 'Badge says "Synced"' : facts.settled ? "Saved" : "Saving");
export const step = (action) => ({ Tap: "you tap Save" })[action] ?? "";
`,
	);
	const r = node("tlc-to-chart.mjs", ["--dot", "save.dot", "--map", "save.map.mjs", "--highlight", "0", "--out", "chart.mmd"], dir);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(edges(parseMermaid(readFileSync(join(dir, "chart.mmd"), "utf8")).regions.Main), ['Badge says "Synced" -> Saving : you tap Save']);
});

test("chart-to-tla writes one action per label and one invariant per never line", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "sync.mmd"), fixture("sync.mmd"));
	const r = node("chart-to-tla.mjs", ["sync.mmd", "--module", "Sync"], dir);
	assert.equal(r.status, 0, r.stderr);
	const spec = readFileSync(join(dir, "Sync.tla"), "utf8");
	assert.match(spec, /^VARIABLES connection, syncBadge$/m);
	assert.match(spec, /^TheNetworkDrops ==\n {4}\/\\ \(connection \\in \{"Online"\} \\\/ syncBadge \\in \{"Synced"\}\)$/m);
	assert.match(spec, /^NeverSyncedWhileOffline == ~\(connection = "Offline" \/\\ syncBadge = "Synced"\)$/m);
	assert.equal(readFileSync(join(dir, "Sync.cfg"), "utf8"), "SPECIFICATION Spec\n\\* Rules, one TLC run each: TypeOK NeverSyncedWhileOffline\n");
	assert.match(r.stderr, /rules TypeOK NeverSyncedWhileOffline/);
});

test("chart-to-tla refuses a never line that names no state", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "c.mmd"), "stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  %% never Bad: C -- never C\n");
	const r = node("chart-to-tla.mjs", ["c.mmd", "--module", "C"], dir);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /names "C", which is not a state/);
});

test("a never line names a state exactly, or every state inside a composite", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(
		join(dir, "c.mmd"),
		`stateDiagram-v2
  state "Saving" as S
  state "Saving..." as S2
  state Busy {
    [*] --> Checking
    Checking --> Sending : the check passes
  }
  [*] --> S
  S --> S2 : you wait
  S2 --> Busy : you send
  Busy --> S : you cancel
  %% never NoSaving: Saving -- You never see Saving.
  %% never NoBusy: Busy -- You are never busy.
`,
	);
	const r = node("chart-to-tla.mjs", ["c.mmd", "--module", "C"], dir);
	assert.equal(r.status, 0, r.stderr);
	const spec = readFileSync(join(dir, "C.tla"), "utf8");
	assert.match(spec, /^NoSaving == ~\(main = "Saving"\)$/m);
	assert.match(spec, /^NoBusy == ~\(main \\in \{"Busy\.Checking", "Busy\.Sending"\}\)$/m);
	assert.match(readFileSync(join(dir, "C.map.mjs"), "utf8"), /^export const readerActions = \[\];$/m);
});

const door = `stateDiagram-v2
  state Door {
    [*] --> Locked
    Locked --> Unlocked : tap unlock
    Unlocked --> Locked : tap lock
    --
    [*] --> Closed
    Closed --> Open : open the door
    Open --> Closed : close the door
  }
  [*] --> Door`;
const flatDoor = (extra = []) =>
	[
		"stateDiagram-v2",
		'  state "Locked | Closed" as L_C',
		'  state "Locked | Open" as L_O',
		'  state "Unlocked | Closed" as U_C',
		'  state "Unlocked | Open" as U_O',
		"  [*] --> L_C",
		"  L_C --> U_C : tap unlock",
		"  U_C --> L_C : tap lock",
		"  L_O --> U_O : tap unlock",
		"  L_C --> L_O : open the door",
		"  L_O --> L_C : close the door",
		"  U_C --> U_O : open the door",
		"  U_O --> U_C : close the door",
		...extra,
	].join("\n");

test("compare reads parallel regions as one machine, so a guard across regions shows", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "agreed.mmd"), door);
	writeFileSync(join(dir, "guarded.mmd"), flatDoor());
	writeFileSync(join(dir, "free.mmd"), flatDoor(["  U_O --> L_O : tap lock"]));
	const differ = node("compare-charts.mjs", ["agreed.mmd", "guarded.mmd"], dir);
	assert.equal(differ.status, 1);
	assert.match(differ.stdout, /transitions only in EXPECTED[^\n]*:\n {2}Unlocked \| Open --> Locked \| Open : tap lock\n1 difference\(s\)/);
	const same = node("compare-charts.mjs", ["agreed.mmd", "free.mmd"], dir);
	assert.equal(same.stdout.trim(), "same", same.stdout);
});

test("a -- outside a composite is refused, not read as one region", () => {
	const split = "stateDiagram-v2\n  [*] --> Online\n  Online --> Offline : the network drops\n  --\n  [*] --> Synced\n  Synced --> Pending : you edit a note\n";
	assert.throws(() => parseMermaid(split), /-- outside a composite/);
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "split.mmd"), split);
	writeFileSync(join(dir, "door.mmd"), door);
	const tla = node("chart-to-tla.mjs", ["split.mmd", "--module", "Split"], dir);
	assert.notEqual(tla.status, 0);
	assert.match(tla.stderr, /-- outside a composite/);
	for (const pair of [["split.mmd", "split.mmd"], ["door.mmd", "split.mmd"], ["split.mmd", "door.mmd"]]) {
		const r = node("compare-charts.mjs", pair, dir);
		assert.notEqual(r.status, 0, pair.join(" "));
		assert.notEqual(r.stdout.trim(), "same");
		assert.match(r.stderr, /-- outside a composite/);
	}
});

test("compare refuses an ACTUAL chart that is not drawn for comparison", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "agreed.mmd"), door);
	for (const [label, why] of [
		["tap lock or …", /--all-labels/],
		["1. tap lock", /--highlight 0/],
		["tap lock (with the fix)", /without --fixed-dot/],
		["tap lock, blocked by the fix", /without --fixed-dot/],
	]) {
		writeFileSync(join(dir, "actual.mmd"), flatDoor([`  U_O --> L_O : ${label}`]));
		const r = node("compare-charts.mjs", ["agreed.mmd", "actual.mmd"], dir);
		assert.equal(r.status, 2, label);
		assert.match(r.stderr, why);
	}
});

const jar = process.env.TLA2TOOLS;
const java = process.env.JAVA ?? "java";
const needsTlc = { skip: jar ? false : "set TLA2TOOLS to run TLC" };

// Without a rule, dump NAME.dot. With a rule, check it alone in NAME-RULE.out, as the SKILL.md loop does.
function tlc(dir, name, rule) {
	const base = rule ? `${name}-${rule}` : name;
	if (rule) writeFileSync(join(dir, `${base}.cfg`), `${readFileSync(join(dir, `${name}.cfg`), "utf8")}\nINVARIANT ${rule}\n`);
	const dump = rule ? [] : ["-dump", "dot,actionlabels", `${name}.dot`];
	const r = spawnSync(
		java,
		["-cp", jar, "tlc2.TLC", "-metadir", mkdtempSync(join(tmpdir(), "tlc-")), "-deadlock", "-continue", ...dump, "-config", `${base}.cfg`, `${name}.tla`],
		{ cwd: dir, encoding: "utf8" },
	);
	writeFileSync(join(dir, `${base}.out`), r.stdout);
	return r;
}

test("chart to TLA+ to chart gives back the same chart", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "upload.mmd"), fixture("upload.mmd"));
	assert.equal(node("chart-to-tla.mjs", ["upload.mmd", "--module", "Upload"], dir).status, 0);
	assert.match(tlc(dir, "Upload").stdout, /Model checking completed\. No error has been found\./);
	const typeOk = tlc(dir, "Upload", "TypeOK");
	assert.equal(typeOk.status, 0, typeOk.stdout);
	assert.doesNotMatch(typeOk.stdout, /^Error:/m);
	const drawn = node("tlc-to-chart.mjs", ["--dot", "Upload.dot", "--map", "Upload.map.mjs", "--highlight", "0", "--out", "again.mmd"], dir);
	assert.equal(drawn.status, 0, drawn.stderr);
	const same = node("compare-charts.mjs", ["upload.mmd", "again.mmd"], dir);
	assert.equal(same.stdout.trim(), "same");
});

test("a never line finds the design bug, and the fixed model marks it fixed", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "sync.mmd"), fixture("sync.mmd"));
	assert.equal(node("chart-to-tla.mjs", ["sync.mmd", "--module", "Sync"], dir).status, 0);
	const rule = "NeverSyncedWhileOffline";
	tlc(dir, "Sync");
	// With -continue, TLC exits 0 and still prints "Model checking completed" after a violation.
	const broken = tlc(dir, "Sync", rule);
	assert.equal(broken.status, 0);
	assert.match(broken.stdout, /Invariant NeverSyncedWhileOffline is violated[^]*Model checking completed\. No error has been found\./);

	const spec = readFileSync(join(dir, "Sync.tla"), "utf8");
	const guarded = spec.replace("TheServerConfirms ==\n", 'TheServerConfirms ==\n    /\\ connection = "Online"\n').replace("MODULE Sync", "MODULE SyncFixed");
	assert.notEqual(guarded, spec);
	writeFileSync(join(dir, "SyncFixed.tla"), guarded);
	writeFileSync(join(dir, "SyncFixed.cfg"), readFileSync(join(dir, "Sync.cfg")));
	tlc(dir, "SyncFixed");
	assert.doesNotMatch(tlc(dir, "SyncFixed", rule).stdout, /is violated/);

	const args = ["--dot", "Sync.dot", "--map", "Sync.map.mjs", "--traces", `Sync-${rule}.out`, "--story", "story.md", "--summary", "summary.json", "--out", "chart.mmd"];
	assert.equal(node("tlc-to-chart.mjs", args, dir).status, 0);
	const before = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
	assert.deepEqual(before.classes.map((c) => [c.end, c.readerSteps]), [["Offline | Synced", 2]]);
	assert.equal(before.chartStatus.wrong, 1);
	assert.match(readFileSync(join(dir, "story.md"), "utf8"), /1\. the network drops\. Now: Offline \| Waiting to sync\n2\. the server confirms\. Now: Offline \| Synced/);
	assert.match(readFileSync(join(dir, "chart.mmd"), "utf8"), /: 2\. the server confirms\n/);

	const withFix = [...args, "--fixed-dot", "SyncFixed.dot", "--fixed-traces", `SyncFixed-${rule}.out`];
	assert.equal(node("tlc-to-chart.mjs", withFix, dir).status, 0);
	const after = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
	assert.deepEqual(after.chartStatus, { works: 3, wrong: 0, fixed: 1 });
	assert.equal(after.classes[0].fix, "Offline | Waiting to sync");
	assert.match(readFileSync(join(dir, "story.md"), "utf8"), /`TheServerConfirms`\) cannot happen/);
});

const pay = (name, charge) => `---- MODULE ${name} ----
EXTENDS Naturals
VARIABLES screen, charges
vars == <<screen, charges>>
Init == screen = "Cart" /\\ charges = 0
Pay == screen = "Cart" /\\ screen' = "Paying" /\\ UNCHANGED charges
Charge == ${charge}
Refund == charges = 2 /\\ charges' = 1 /\\ screen' = "Refunded"
Next == Pay \\/ Charge \\/ Refund
Spec == Init /\\ [][Next]_vars
NoDoubleCharge == charges <= 1
====
`;
const payMap = `export const readerActions = ["Pay"];
export const state = (v) => v.screen + ["", ", charged", ", charged twice"][v.charges];
export const step = (action) => ({ Pay: "you pay", Charge: "the bank charges you", Refund: "the bank refunds you" })[action] ?? "";
export const cause = () => "each charge request charges again";
`;

test("a state reached only after a bug takes the bug's color, and the fix edge leaves the state before the changed step", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	const cfg = "SPECIFICATION Spec\nINVARIANT NoDoubleCharge\n";
	writeFileSync(join(dir, "Pay.tla"), pay("Pay", `screen = "Paying" /\\ charges < 2 /\\ charges' = charges + 1 /\\ UNCHANGED screen`));
	writeFileSync(
		join(dir, "PayFixed.tla"),
		pay("PayFixed", `screen = "Paying" /\\ charges < 2 /\\ IF charges = 0 THEN charges' = 1 /\\ UNCHANGED screen ELSE screen' = "Paid" /\\ UNCHANGED charges`),
	);
	writeFileSync(join(dir, "Pay.cfg"), cfg);
	writeFileSync(join(dir, "PayFixed.cfg"), cfg);
	writeFileSync(join(dir, "pay.map.mjs"), payMap);
	assert.match(tlc(dir, "Pay").stdout, /Invariant NoDoubleCharge is violated/);
	assert.doesNotMatch(tlc(dir, "PayFixed").stdout, /is violated/);

	const statusOf = (chart) => {
		const names = new Map([...chart.matchAll(/^ {2}state "([^"]+)" as (s\d+)$/gm)].map((m) => [m[2], m[1].replace(/<br\/>/g, " ")]));
		return Object.fromEntries([...chart.matchAll(/^ {2}class (s\d+) (\w+)$/gm)].map((m) => [names.get(m[1]), m[2]]));
	};
	const args = ["--dot", "Pay.dot", "--map", "pay.map.mjs", "--traces", "Pay.out", "--highlight", "0", "--out", "chart.mmd"];
	assert.equal(node("tlc-to-chart.mjs", args, dir).status, 0);
	assert.deepEqual(statusOf(readFileSync(join(dir, "chart.mmd"), "utf8")), {
		Cart: "works",
		Paying: "works",
		"Paying, charged": "works",
		"Paying, charged twice": "wrong",
		"Refunded, charged": "wrong",
	});

	const withFix = [...args, "--fixed-dot", "PayFixed.dot", "--fixed-traces", "PayFixed.out"];
	assert.equal(node("tlc-to-chart.mjs", withFix, dir).status, 0);
	const chart = readFileSync(join(dir, "chart.mmd"), "utf8");
	assert.deepEqual(statusOf(chart), {
		Cart: "works",
		"Paid, charged": "fixed",
		Paying: "works",
		"Paying, charged": "works",
		"Paying, charged twice": "fixed",
		"Refunded, charged": "fixed",
	});
	const fixEdges = parseMermaid(chart).regions.Main.transitions.filter((t) => t.label.endsWith("with the fix"));
	assert.deepEqual(
		fixEdges.map((t) => `${t.from} --> ${t.to} : ${t.label}`),
		["Paying, charged --> Paid, charged : the bank charges you, with the fix"],
	);
});

test("a rule broken by a start state marks that state wrong", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(
		join(dir, "Start.tla"),
		`---- MODULE Start ----
VARIABLES conn, badge
vars == <<conn, badge>>
Init == conn \\in {"Online", "Offline"} /\\ badge = "Synced"
Drop == conn = "Online" /\\ conn' = "Offline" /\\ badge' = "Waiting"
Next == Drop
Spec == Init /\\ [][Next]_vars
NeverSyncedWhileOffline == ~(conn = "Offline" /\\ badge = "Synced")
====
`,
	);
	writeFileSync(join(dir, "Start.cfg"), "SPECIFICATION Spec\nINVARIANT NeverSyncedWhileOffline\n");
	writeFileSync(join(dir, "start.map.mjs"), 'export const state = (v) => `${v.conn} | ${v.badge}`;\nexport const step = () => "the network drops";\n');
	assert.match(tlc(dir, "Start").stdout, /is violated by the initial state/);
	const args = ["--dot", "Start.dot", "--map", "start.map.mjs", "--traces", "Start.out", "--summary", "summary.json", "--out", "chart.mmd"];
	const r = node("tlc-to-chart.mjs", args, dir);
	assert.equal(r.status, 0, r.stderr);
	const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
	assert.deepEqual(summary.classes.map((c) => [c.end, c.readerSteps]), [["Offline | Synced", 0]]);
	assert.deepEqual(summary.chartStatus, { works: 2, wrong: 1, fixed: 0 });
});

const edit = (name, fixed) => `---- MODULE ${name} ----
VARIABLES s, flashed
vars == <<s, flashed>>
Init == s = "Idle" /\\ flashed = FALSE
Tap == s = "Idle" /\\ s' = "Saving" /\\ UNCHANGED flashed
Lose == s = "Saving" /\\ s' = "Lost edit" /\\ UNCHANGED flashed
Flash == s = "Saving" /\\ s' = "Flash" /\\ flashed' = ${fixed ? "TRUE" : "FALSE"}
Back == s \\in {"Lost edit", "Flash"} /\\ s' = "Idle" /\\ flashed' = FALSE
Next == Tap \\/ Flash \\/ Back${fixed ? "" : " \\/ Lose"}
Spec == Init /\\ [][Next]_vars
NoLostEdit == s # "Lost edit" /\\ ~(s = "Flash" /\\ flashed)
====
`;

test("a bug that only the fixed model has is numbered after the current bugs and drawn wrong", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	const cfg = "SPECIFICATION Spec\nINVARIANT NoLostEdit\n";
	for (const [name, fixed] of [["Edit", false], ["EditFixed", true]]) {
		writeFileSync(join(dir, `${name}.tla`), edit(name, fixed));
		writeFileSync(join(dir, `${name}.cfg`), cfg);
		assert.match(tlc(dir, name).stdout, /Invariant NoLostEdit is violated/);
	}
	writeFileSync(
		join(dir, "edit.map.mjs"),
		'export const readerActions = ["Tap"];\nexport const state = (v) => v.s;\nexport const step = (a) => ({ Tap: "you tap Save", Lose: "the save fails", Flash: "the screen flashes", Back: "you go back" })[a] ?? "";\n',
	);
	const args = ["--dot", "Edit.dot", "--map", "edit.map.mjs", "--traces", "Edit.out", "--fixed-dot", "EditFixed.dot", "--fixed-traces", "EditFixed.out"];
	const r = node("tlc-to-chart.mjs", [...args, "--cover", "--highlight", "0", "--story", "story.md", "--summary", "summary.json", "--out", "chart.mmd"], dir);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /1 bug\(s\), 1 new with the fix/);
	const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
	assert.deepEqual(summary.classes.map((c) => [c.n, c.end, c.fix]), [
		[1, "Lost edit", "Saving"],
		[2, "Flash", "new with the fix"],
	]);
	assert.deepEqual(summary.chartStatus, { works: 2, wrong: 1, fixed: 1 });
	assert.match(readFileSync(join(dir, "story.md"), "utf8"), /^## 2\. New with the fix: Flash$/m);
	const two = node("tlc-to-chart.mjs", [...args, "--highlight", "2", "--path-only", "--out", "bug2.mmd"], dir);
	assert.equal(two.status, 0, two.stderr);
	assert.match(readFileSync(join(dir, "bug2.mmd"), "utf8"), /: 2\. the screen flashes\n/);
});
