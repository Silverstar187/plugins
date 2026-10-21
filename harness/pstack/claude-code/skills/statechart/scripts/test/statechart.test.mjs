// node --test scripts/test/statechart.test.mjs
// Set TLA2TOOLS (path to tla2tools.jar) and JAVA (java binary, default "java") to run the TLC tests too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDot, parseMermaid, parseTraces, parseValue } from "../lib.mjs";

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
});

test("TLC values, states, graphs, and traces parse", () => {
	assert.deepEqual(parseValue('[a |-> <<1, "x">>, b |-> {TRUE}]'), { a: [1, "x"], b: [true] });
	assert.deepEqual(parseValue('("p" :> 1 @@ "q" :> 2)'), { p: 1, q: 2 });
	const graph = parseDot(`strict digraph DiskGraph {
1 [label="/\\\\ x = 0",style = filled]
2 [label="/\\\\ x = 1"]
1 -> 2 [label="Inc",color="black",fontcolor="black"];
2 -> 2 [label="Stay"];
}`);
	assert.equal(graph.nodes.get("1").init, true);
	assert.deepEqual(graph.nodes.get("2").vars, { x: 1 });
	assert.deepEqual(graph.edges, [{ from: "1", to: "2", action: "Inc" }]);
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

test("chart-to-tla writes one action per label and one invariant per never line", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "sync.mmd"), fixture("sync.mmd"));
	const r = node("chart-to-tla.mjs", ["sync.mmd", "--module", "Sync"], dir);
	assert.equal(r.status, 0, r.stderr);
	const spec = readFileSync(join(dir, "Sync.tla"), "utf8");
	assert.match(spec, /^VARIABLES connection, syncBadge$/m);
	assert.match(spec, /^TheNetworkDrops ==\n {4}\/\\ \(connection \\in \{"Online"\} \\\/ syncBadge \\in \{"Synced"\}\)$/m);
	assert.match(spec, /^NeverSyncedWhileOffline == ~\(connection = "Offline" \/\\ syncBadge = "Synced"\)$/m);
	assert.equal(readFileSync(join(dir, "Sync.cfg"), "utf8"), "SPECIFICATION Spec\nINVARIANT TypeOK\nINVARIANT NeverSyncedWhileOffline\n");
});

test("chart-to-tla refuses a never line that names no state", () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "c.mmd"), "stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  %% never Bad: C -- never C\n");
	const r = node("chart-to-tla.mjs", ["c.mmd", "--module", "C"], dir);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /names "C", which is not a state/);
});

const jar = process.env.TLA2TOOLS;
const java = process.env.JAVA ?? "java";
const needsTlc = { skip: jar ? false : "set TLA2TOOLS to run TLC" };

function tlc(dir, name) {
	const r = spawnSync(
		java,
		["-cp", jar, "tlc2.TLC", "-metadir", mkdtempSync(join(tmpdir(), "tlc-")), "-deadlock", "-continue", "-dump", "dot,actionlabels", `${name}.dot`, "-config", `${name}.cfg`, `${name}.tla`],
		{ cwd: dir, encoding: "utf8" },
	);
	writeFileSync(join(dir, `${name}.out`), r.stdout);
	return r;
}

test("chart to TLA+ to chart gives back the same chart", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "upload.mmd"), fixture("upload.mmd"));
	assert.equal(node("chart-to-tla.mjs", ["upload.mmd", "--module", "Upload"], dir).status, 0);
	assert.match(tlc(dir, "Upload").stdout, /Model checking completed\. No error has been found\./);
	const drawn = node("tlc-to-chart.mjs", ["--dot", "Upload.dot", "--map", "Upload.map.mjs", "--highlight", "0", "--out", "again.mmd"], dir);
	assert.equal(drawn.status, 0, drawn.stderr);
	const same = node("compare-charts.mjs", ["upload.mmd", "again.mmd"], dir);
	assert.equal(same.stdout.trim(), "same");
});

test("a never line finds the design bug, and the fixed model marks it fixed", needsTlc, () => {
	const dir = mkdtempSync(join(tmpdir(), "statechart-"));
	writeFileSync(join(dir, "sync.mmd"), fixture("sync.mmd"));
	assert.equal(node("chart-to-tla.mjs", ["sync.mmd", "--module", "Sync"], dir).status, 0);
	// With -continue, TLC exits 0 even when it finds a violation.
	assert.match(tlc(dir, "Sync").stdout, /Invariant NeverSyncedWhileOffline is violated/);

	const spec = readFileSync(join(dir, "Sync.tla"), "utf8");
	const guarded = spec.replace("TheServerConfirms ==\n", 'TheServerConfirms ==\n    /\\ connection = "Online"\n').replace("MODULE Sync", "MODULE SyncFixed");
	assert.notEqual(guarded, spec);
	writeFileSync(join(dir, "SyncFixed.tla"), guarded);
	writeFileSync(join(dir, "SyncFixed.cfg"), readFileSync(join(dir, "Sync.cfg")));
	assert.doesNotMatch(tlc(dir, "SyncFixed").stdout, /is violated/);

	const args = ["--dot", "Sync.dot", "--map", "Sync.map.mjs", "--traces", "Sync.out", "--story", "story.md", "--summary", "summary.json", "--out", "chart.mmd"];
	assert.equal(node("tlc-to-chart.mjs", args, dir).status, 0);
	const before = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
	assert.deepEqual(before.classes.map((c) => [c.end, c.readerSteps]), [["Offline | Synced", 2]]);
	assert.equal(before.chartStatus.wrong, 1);
	assert.match(readFileSync(join(dir, "story.md"), "utf8"), /1\. the network drops\. Now: Offline \| Waiting to sync\n2\. the server confirms\. Now: Offline \| Synced/);
	assert.match(readFileSync(join(dir, "chart.mmd"), "utf8"), /: 2\. the server confirms\n/);

	const withFix = [...args, "--fixed-dot", "SyncFixed.dot", "--fixed-traces", "SyncFixed.out"];
	assert.equal(node("tlc-to-chart.mjs", withFix, dir).status, 0);
	const after = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
	assert.deepEqual(after.chartStatus, { works: 3, wrong: 0, fixed: 1 });
	assert.equal(after.classes[0].fix, "Offline | Waiting to sync");
	assert.match(readFileSync(join(dir, "story.md"), "utf8"), /`TheServerConfirms`\) cannot happen/);
});
