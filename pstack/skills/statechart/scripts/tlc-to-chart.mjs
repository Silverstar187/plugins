#!/usr/bin/env node
// Collapse a TLC state graph onto the reader's states and write a Mermaid stateDiagram-v2.
//
//   node tlc-to-chart.mjs --dot graph.dot --map mapping.mjs [options]
//
//   --dot FILE        state graph from TLC -dump dot,actionlabels FILE (the current code)
//   --map FILE        mapping module: state(vars, facts), optional detail(vars, facts),
//                     step(action, before, after), cause(vars, facts, invariant) (the hidden reason a bad state is bad;
//                     counterexamples with the same invariant and cause are one bug), and
//                     readerActions (the actions the reader takes).
//                     facts.enabled is the set of actions the state enables; facts.settled is true when
//                     only reader actions are enabled, so nothing else happens until the reader acts.
//   --traces FILE     TLC output that holds counterexamples (repeat; -continue gives one per bad state).
//                     A file from a TLC run that stopped early or hit an error other than a broken rule is refused.
//   --fixed-dot FILE  state graph of the model with the open fix; counterexamples replay against it
//   --fixed-traces F  TLC output for the same invariants on the fixed model (repeat); marks states fixed or still
//                     wrong, and adds the bugs that only the fixed model has after the current model's bugs
//   --view NAME       customer (state labels), developer (detail labels), or layered (detail inside state)
//   --cover           keep only the shortest path to each settled reader state, plus counterexample paths
//   --highlight N     draw counterexample class N as a numbered path (default 1; 0 for none)
//   --path-only       draw only the highlighted path
//   --all-labels      write every label on an edge (default: the two most common, then " or …")
//   --title TEXT      chart title
//   --out FILE        Mermaid output (default stdout)
//   --story FILE      reader stories, one per counterexample class
//   --summary FILE    JSON counts for the chart and the classes
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LEGEND_ID, checkTlcOutput, parseDot, parseTraces, quote, stateKey, wrap, STATUS_CLASSES } from "./lib.mjs";

const args = { traces: [], fixedTraces: [], view: "customer", highlight: 1 };
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	const next = () => process.argv[++i];
	if (a === "--dot") args.dot = next();
	else if (a === "--map") args.map = next();
	else if (a === "--traces") args.traces.push(next());
	else if (a === "--fixed-dot") args.fixedDot = next();
	else if (a === "--fixed-traces") args.fixedTraces.push(next());
	else if (a === "--view") args.view = next();
	else if (a === "--highlight") args.highlight = Number(next());
	else if (a === "--path-only") args.pathOnly = true;
	else if (a === "--all-labels") args.allLabels = true;
	else if (a === "--cover") args.cover = true;
	else if (a === "--title") args.title = next();
	else if (a === "--out") args.out = next();
	else if (a === "--story") args.story = next();
	else if (a === "--summary") args.summary = next();
	else {
		console.error(`unknown argument ${a}`);
		process.exit(2);
	}
}
if (!args.dot || !args.map) {
	console.error("Usage: node tlc-to-chart.mjs --dot graph.dot --map mapping.mjs [--traces tlc.out] [--fixed-dot fixed.dot] [--view customer|developer|layered]");
	process.exit(2);
}
if (!["customer", "developer", "layered"].includes(args.view)) {
	console.error(`--view must be customer, developer, or layered, not ${args.view}`);
	process.exit(2);
}

const mapping = await import(pathToFileURL(path.resolve(args.map)).href);
if (typeof mapping.state !== "function") throw new Error("the mapping module must export state(vars)");
if (args.view !== "customer" && typeof mapping.detail !== "function") throw new Error(`--view ${args.view} needs detail(vars) in the mapping module`);
const SEP = "\u0000";

const readerActions = new Set(mapping.readerActions ?? []);
const factsFrom = (enabled) => ({ enabled, settled: [...enabled].every((a) => readerActions.has(a)) });
let factsOf = () => factsFrom(new Set());
function keyOf(vars) {
	const facts = factsOf(vars);
	if (args.view === "developer") return String(mapping.detail(vars, facts));
	const outer = mapping.state(vars, facts);
	if (typeof outer !== "string") throw new Error(`state() must return a string; got ${JSON.stringify(outer)}`);
	return args.view === "layered" ? `${outer}${SEP}${mapping.detail(vars, facts)}` : outer;
}
function stepLabel(action, before, after) {
	const said = typeof mapping.step === "function" ? mapping.step(action, before, after) : action;
	return args.view === "customer" || said === action ? said : `${said} [${action}]`;
}

function quotient(graph) {
	const keys = new Map();
	for (const n of graph.nodes.values()) keys.set(n.id, keyOf(n.vars));
	const nodes = new Set(keys.values());
	const initial = new Set([...graph.nodes.values()].filter((n) => n.init).map((n) => keys.get(n.id)));
	const edges = new Map();
	for (const e of graph.edges) {
		const from = keys.get(e.from);
		const to = keys.get(e.to);
		if (from === to) continue;
		const id = `${from}${SEP}${SEP}${to}`;
		if (!edges.has(id)) edges.set(id, { from, to, counts: new Map() });
		const label = stepLabel(e.action, graph.nodes.get(e.from).vars, graph.nodes.get(e.to).vars);
		if (label) edges.get(id).counts.set(label, (edges.get(id).counts.get(label) ?? 0) + 1);
	}
	// Most common wording first. A chart edge shows two unless --all-labels.
	for (const e of edges.values()) e.labels = new Set([...e.counts].sort((a, b) => b[1] - a[1]).map(([l]) => l));
	const settled = new Set([...graph.nodes.values()].filter((n) => factsOf(n.vars).settled).map((n) => keys.get(n.id)));
	return { nodes, initial, edges, keys, settled };
}

function enabledIndex(g) {
	const byId = new Map([...g.nodes.keys()].map((id) => [id, new Set()]));
	for (const e of [...g.edges, ...g.loops]) byId.get(e.from).add(e.action);
	return new Map([...g.nodes.values()].map((n) => [stateKey(n.vars), byId.get(n.id)]));
}
function useFacts(index) {
	factsOf = (vars) => factsFrom(index.get(stateKey(vars)) ?? new Set());
}

const graph = parseDot(fs.readFileSync(args.dot, "utf8"));
const graphIndex = enabledIndex(graph);
useFacts(graphIndex);
const now = quotient(graph);
const fixedGraph = args.fixedDot ? parseDot(fs.readFileSync(args.fixedDot, "utf8")) : null;
const fixedIndex = fixedGraph ? enabledIndex(fixedGraph) : null;
let fixed = null;
if (fixedGraph) {
	useFacts(fixedIndex);
	fixed = quotient(fixedGraph);
	useFacts(graphIndex);
}

const customerKey = (vars) => String(mapping.state(vars, factsOf(vars)));

// Reader path of one trace: drop system steps that keep the reader in the same state.
// Reader actions stay even then, because the reader did them.
function readerPath(trace, key0 = keyOf) {
	const out = [{ key: key0(trace.steps[0].vars), label: null, modelStep: 0 }];
	for (let i = 1; i < trace.steps.length; i++) {
		const key = key0(trace.steps[i].vars);
		if (key === out[out.length - 1].key && !readerActions.has(trace.steps[i].action)) continue;
		const label = stepLabel(trace.steps[i].action, trace.steps[i - 1].vars, trace.steps[i].vars) || trace.steps[i].action;
		out.push({ key, label, modelStep: i });
	}
	return out;
}

// Replay a trace's actions in the fixed graph. Returns where the fixed model leaves the trace.
function replayFixed(trace) {
	if (!fixedGraph) return null;
	const byKey = new Map([...fixedGraph.nodes.values()].map((n) => [stateKey(n.vars), n]));
	const out = new Map();
	for (const e of [...fixedGraph.edges, ...fixedGraph.loops]) {
		if (!out.has(e.from)) out.set(e.from, []);
		out.get(e.from).push(e);
	}
	let cur = byKey.get(stateKey(trace.steps[0].vars));
	if (!cur) return { step: 0, reason: "the fixed model has no matching initial state" };
	for (let i = 1; i < trace.steps.length; i++) {
		const want = trace.steps[i];
		const same = (out.get(cur.id) ?? []).filter((e) => e.action === want.action);
		const exact = same.find((e) => stateKey(fixedGraph.nodes.get(e.to).vars) === stateKey(want.vars));
		if (exact) {
			cur = fixedGraph.nodes.get(exact.to);
			continue;
		}
		const score = (vars) => Object.keys(want.vars).filter((k) => JSON.stringify(vars[k]) === JSON.stringify(want.vars[k])).length;
		const best = same.map((e) => fixedGraph.nodes.get(e.to)).sort((a, b) => score(b.vars) - score(a.vars))[0];
		const reached = best ?? cur;
		useFacts(fixedIndex);
		const key = keyOf(reached.vars);
		useFacts(graphIndex);
		return { step: i, action: want.action, disabled: !best, key };
	}
	return { step: trace.steps.length, sameEnd: true };
}

function readTraces(files) {
	return files.flatMap((f) => {
		const text = fs.readFileSync(f, "utf8");
		checkTlcOutput(text, f);
		return parseTraces(text);
	});
}
// With -continue, TLC reports every bad state, including states after the first bad one.
// Cut each trace at its first bad state so one bug counts once.
function firstBad(raw) {
	const badStates = new Map();
	for (const t of raw) {
		if (!badStates.has(t.invariant)) badStates.set(t.invariant, new Set());
		badStates.get(t.invariant).add(stateKey(t.steps[t.steps.length - 1].vars));
	}
	const cuts = [];
	const seen = new Set();
	for (const t of raw) {
		const first = t.steps.findIndex((s) => badStates.get(t.invariant).has(stateKey(s.vars)));
		const cut = { invariant: t.invariant, steps: t.steps.slice(0, first + 1) };
		const id = `${t.invariant}${SEP}${stateKey(cut.steps[cut.steps.length - 1].vars)}`;
		if (seen.has(id)) continue;
		seen.add(id);
		cuts.push(cut);
	}
	return cuts;
}
const rawTraces = readTraces(args.traces);
const rawFixedTraces = readTraces(args.fixedTraces);
const traces = firstBad(rawTraces);
const fixedTraces = firstBad(rawFixedTraces);
// Classes and their shortest traces come from the customer states in every view,
// so class N is the same bug and the same trace in the customer and developer charts.
function group(cuts) {
	const byId = new Map();
	for (const trace of cuts) {
		const rp = readerPath(trace, customerKey);
		const last = trace.steps[trace.steps.length - 1].vars;
		const cause = typeof mapping.cause === "function" ? String(mapping.cause(last, factsOf(last), trace.invariant)) : null;
		const id = `${trace.invariant}${SEP}${cause ?? rp[rp.length - 1].key}`;
		const prev = byId.get(id);
		if (!prev || rp.length < prev.steps || (rp.length === prev.steps && trace.steps.length < prev.trace.steps.length)) {
			byId.set(id, { id, cause, steps: rp.length, trace, invariant: trace.invariant, count: (prev?.count ?? 0) + 1 });
		} else prev.count++;
	}
	return byId;
}
const byOrder = (a, b) => a.steps - b.steps || a.trace.steps.length - b.trace.steps.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const classesById = group(traces);
const classes = [...classesById.values()].sort(byOrder);
for (const c of classes) {
	c.path = readerPath(c.trace);
	c.end = c.path[c.path.length - 1].key;
	c.fix = replayFixed(c.trace);
}
// A bug of the fixed model that no current bug matches is new with the fix. It numbers after the current bugs.
useFacts(fixedIndex ?? graphIndex);
const introduced = [...group(fixedTraces).values()].filter((c) => !classesById.has(c.id)).sort(byOrder);
for (const c of introduced) {
	c.path = readerPath(c.trace);
	c.end = c.path[c.path.length - 1].key;
	c.fix = null;
	c.introduced = true;
}
useFacts(graphIndex);
classes.push(...introduced);

// ---------- status ----------
// A chart state is bad when it holds a state that breaks a rule, or when every path from the start to
// it passes such a state: what the reader sees after a bug is part of that bug. It is still wrong when
// it is bad in the fixed model, and fixed when it is bad only in the current model.
// Without --fixed-traces every bad state is wrong.
const isFixed = (c) => c.fix?.key !== undefined && c.fix.key !== c.end;
function badKeys(g, keys, raw) {
	const bad = new Set(raw.map((t) => stateKey(t.steps[t.steps.length - 1].vars)));
	const out = new Set(raw.map((t) => keyOf(t.steps[t.steps.length - 1].vars)));
	if (!g) return out;
	const ok = (id) => !bad.has(stateKey(g.nodes.get(id).vars));
	const next = new Map();
	for (const e of g.edges) {
		if (!next.has(e.from)) next.set(e.from, []);
		next.get(e.from).push(e.to);
	}
	const clean = new Set([...g.nodes.values()].filter((n) => n.init && ok(n.id)).map((n) => n.id));
	const queue = [...clean];
	while (queue.length) {
		for (const to of next.get(queue.shift()) ?? []) {
			if (clean.has(to) || !ok(to)) continue;
			clean.add(to);
			queue.push(to);
		}
	}
	const reached = new Set([...clean].map((id) => keys.get(id)));
	for (const k of keys.values()) if (!reached.has(k)) out.add(k);
	return out;
}
const badNow = badKeys(graph, now.keys, rawTraces);
useFacts(fixedIndex ?? graphIndex);
const badFixed = args.fixedTraces.length > 0 ? badKeys(fixedGraph, fixed?.keys, rawFixedTraces) : badNow;
useFacts(graphIndex);
const allNodes = new Set([...now.nodes, ...(fixed?.nodes ?? [])]);
const status = (k) => (badFixed.has(k) ? "wrong" : badNow.has(k) || (fixed && !now.nodes.has(k)) ? "fixed" : "works");

const edges = new Map(now.edges);
if (fixed) {
	for (const [id, e] of fixed.edges) {
		if (!edges.has(id)) edges.set(id, { ...e, labels: new Set([...e.labels].map((l) => `${l} (with the fix)`)), fixedOnly: true });
	}
}
// The fix changes one model step of the counterexample. Its edge leaves the chart state before that
// step and ends where the fixed model goes instead, or stays put when the fix blocks the step.
const fixEdgeId = (c) => `${c.fix.from}${SEP}${SEP}${c.fix.key}${SEP}fix`;
for (const c of classes) {
	if (!isFixed(c)) continue;
	const [before, after] = [c.trace.steps[c.fix.step - 1].vars, c.trace.steps[c.fix.step].vars];
	c.fix.from = keyOf(before);
	const said = stepLabel(c.fix.action, before, after) || c.fix.action;
	const id = fixEdgeId(c);
	if (!edges.has(id)) edges.set(id, { from: c.fix.from, to: c.fix.key, labels: new Set(), fixedOnly: true, fixOf: new Set() });
	edges.get(id).labels.add(c.fix.disabled ? `${said}, blocked by the fix` : `${said}, with the fix`);
	edges.get(id).fixOf.add(c);
}

// ---------- highlighted path ----------
const chosen = args.highlight > 0 ? classes[args.highlight - 1] : null;
if (args.highlight > 0 && classes.length > 0 && !chosen) throw new Error(`--highlight ${args.highlight}: only ${classes.length} classes`);
const onPath = new Set(chosen ? chosen.path.map((p) => p.key) : []);
const pathNumbers = new Map();
if (chosen) {
	chosen.path.slice(1).forEach((p, i) => {
		const id = `${chosen.path[i].key}${SEP}${SEP}${p.key}`;
		if (!pathNumbers.has(id)) pathNumbers.set(id, { n: [], label: p.label });
		pathNumbers.get(id).n.push(i + 1);
		if (!edges.has(id)) edges.set(id, { from: chosen.path[i].key, to: p.key, labels: new Set([p.label]) });
	});
	if (isFixed(chosen)) onPath.add(chosen.fix.key);
}

// ---------- cover: shortest path to each settled reader state ----------
let coverEdges = null;
if (args.cover) {
	const keepEdges = new Set();
	const bfs = (q, targets) => {
		const parent = new Map([...q.initial].map((k) => [k, null]));
		const queue = [...q.initial];
		const outEdges = new Map();
		for (const [id, e] of q.edges) {
			if (!outEdges.has(e.from)) outEdges.set(e.from, []);
			outEdges.get(e.from).push([id, e]);
		}
		while (queue.length) {
			const k = queue.shift();
			for (const [id, e] of outEdges.get(k) ?? []) {
				if (parent.has(e.to)) continue;
				parent.set(e.to, id);
				queue.push(e.to);
			}
		}
		for (const t of targets) {
			for (let id = parent.get(t); id; id = parent.get(q.edges.get(id).from)) keepEdges.add(id);
		}
	};
	bfs(now, now.settled);
	if (fixed) bfs(fixed, [...fixed.settled].filter((k) => !now.nodes.has(k)));
	for (const c of classes) {
		c.path.slice(1).forEach((p, i) => keepEdges.add(`${c.path[i].key}${SEP}${SEP}${p.key}`));
		if (isFixed(c)) keepEdges.add(fixEdgeId(c));
	}
	for (const id of keepEdges) {
		if (!edges.has(id)) {
			const [from, to] = id.split(`${SEP}${SEP}`);
			const c = classes.find((x) => x.path.some((p, i) => i > 0 && x.path[i - 1].key === from && p.key === to));
			const step = c?.path.find((p, i) => i > 0 && c.path[i - 1].key === from && p.key === to);
			edges.set(id, { from, to, labels: new Set([step?.label ?? ""]) });
		}
	}
	coverEdges = keepEdges;
}

// ---------- Mermaid ----------
let keep = allNodes;
if (args.pathOnly && chosen) keep = onPath;
else if (coverEdges) {
	keep = new Set([...now.initial, ...(fixed?.initial ?? [])]);
	for (const id of coverEdges) keep.add(edges.get(id).from).add(edges.get(id).to);
}
const ids = new Map();
let counter = 0;
const idOf = (k) => {
	if (!ids.has(k)) ids.set(k, `s${counter++}`);
	return ids.get(k);
};
const label = (k) => (args.view === "layered" ? k.split(SEP)[1] : k);
const out = [];
if (args.title) out.push("---", `title: ${JSON.stringify(args.title)}`, "---");
out.push("stateDiagram-v2");
for (const c of STATUS_CLASSES) out.push(`  ${c}`);
out.push(`  state "Legend" as ${LEGEND_ID} {`);
out.push('    state "Works today" as legendWorks', '    state "Still wrong" as legendWrong', '    state "Fixed or new in an open PR" as legendFixed');
out.push("  }", "  class legendWorks works", "  class legendWrong wrong", "  class legendFixed fixed");
const sorted = [...keep].sort();
if (args.view === "layered") {
	const groups = new Map();
	for (const k of sorted) {
		const outer = k.split(SEP)[0];
		if (!groups.has(outer)) groups.set(outer, []);
		groups.get(outer).push(k);
	}
	let g = 0;
	for (const [outer, members] of groups) {
		out.push(`  state "${quote(wrap(outer))}" as g${g++} {`);
		for (const k of members) out.push(`    state "${quote(wrap(label(k)))}" as ${idOf(k)}`);
		out.push("  }");
	}
} else {
	for (const k of sorted) out.push(`  state "${quote(wrap(label(k)))}" as ${idOf(k)}`);
}
const initial = new Set([...now.initial, ...(fixed?.initial ?? [])]);
for (const k of sorted) if (initial.has(k) && (!args.pathOnly || k === chosen?.path[0].key)) out.push(`  [*] --> ${idOf(k)}`);
let edgeCount = 0;
for (const [id, e] of edges) {
	if (!keep.has(e.from) || !keep.has(e.to)) continue;
	if (args.pathOnly && chosen && !pathNumbers.has(id) && !e.fixOf?.has(chosen)) continue;
	if (coverEdges && !coverEdges.has(id)) continue;
	const all = [...e.labels];
	let text = args.allLabels ? all.join(" or ") : all.slice(0, 2).join(" or ") + (all.length > 2 ? " or …" : "");
	const p = pathNumbers.get(id);
	if (p) text = `${p.n.join(", ")}. ${p.label}`;
	// ";" ends a Mermaid statement, even inside a transition label.
	text = text.replaceAll(";", ",");
	out.push(`  ${idOf(e.from)} --> ${idOf(e.to)}${text ? ` : ${wrap(text, 30)}` : ""}`);
	edgeCount++;
}
for (const k of sorted) out.push(`  class ${idOf(k)} ${status(k)}${onPath.has(k) ? "Path" : ""}`);
const mermaid = out.join("\n") + "\n";
if (args.out) fs.writeFileSync(args.out, mermaid);
else process.stdout.write(mermaid);

// ---------- stories and summary ----------
const show = (k) => (args.view === "layered" ? k.replace(SEP, ": ") : k);
if (args.story) {
	const lines = [];
	classes.forEach((c, i) => {
		lines.push(`## ${i + 1}. ${c.introduced ? "New with the fix: " : ""}${show(c.end)}`, "");
		lines.push(`Breaks \`${c.invariant}\`${c.cause ? ` (${c.cause})` : ""}. Shortest of ${c.count} counterexample(s) that end here: ${c.trace.steps.length} model steps, ${c.path.length - 1} reader steps.`, "");
		c.path.forEach((p, j) => lines.push(j === 0 ? `0. Start: ${show(p.key)}` : `${j}. ${p.label}. Now: ${show(p.key)}`));
		lines.push("");
		if (c.introduced) lines.push("Only the fixed model has this bug. The path above is in the fixed model.");
		else if (!c.fix) lines.push("No fixed model given.");
		else if (c.fix.sameEnd) lines.push("The fixed model follows the whole trace: the fix does not change this path.");
		else if (c.fix.reason) lines.push(`The fixed model cannot replay this trace: ${c.fix.reason}.`);
		else lines.push(`With the fix, model step ${c.fix.step} (\`${c.fix.action}\`) ${c.fix.disabled ? "cannot happen" : "goes elsewhere"}, and you see: ${show(c.fix.key)}`);
		lines.push("");
	});
	fs.writeFileSync(args.story, lines.join("\n"));
}
const summary = {
	view: args.view,
	modelStates: graph.nodes.size,
	modelTransitions: graph.edges.length,
	chartStates: keep.size,
	chartTransitions: edgeCount,
	chartStatus: Object.fromEntries(["works", "wrong", "fixed"].map((s) => [s, [...keep].filter((k) => status(k) === s).length])),
	classes: classes.map((c, i) => ({
		n: i + 1,
		end: show(c.end),
		invariant: c.invariant,
		cause: c.cause,
		readerSteps: c.path.length - 1,
		modelSteps: c.trace.steps.length,
		counterexamples: c.count,
		fix: c.introduced ? "new with the fix" : c.fix ? (c.fix.sameEnd ? "unchanged" : c.fix.reason ?? show(c.fix.key)) : null,
	})),
};
if (args.summary) fs.writeFileSync(args.summary, JSON.stringify(summary, null, 2) + "\n");
console.error(
	`chart: ${summary.chartStates} states, ${summary.chartTransitions} transitions from ${summary.modelStates} model states; ` +
		`${classes.length - introduced.length} bug(s)${introduced.length ? `, ${introduced.length} new with the fix` : ""}`,
);
