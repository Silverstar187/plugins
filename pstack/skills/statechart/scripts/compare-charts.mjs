#!/usr/bin/env node
// Compare two Mermaid stateDiagram-v2 charts: reachable states, start states, and labeled transitions.
//
//   node compare-charts.mjs EXPECTED.mmd ACTUAL.mmd
//
// Use it to check that a spec still draws the chart the reader agreed to: EXPECTED is the agreed chart,
// ACTUAL is what tlc-to-chart.mjs drew from the spec in the customer view with --highlight 0 --all-labels,
// without --cover or --fixed-dot. A chart with parallel regions compares as its combined machine
// (productOf in lib.mjs), so a guard that blocks a step in only some combinations of regions shows as a
// difference. A combined state is the region states joined by " | " in region order, which is what
// chart-to-tla.mjs's mapping writes. An edge label "a or b" counts as two labels. An unlabeled edge counts
// only when no labeled edge joins the same two states, because tlc-to-chart.mjs draws only the labels.
// Exits 1 when the charts differ and 2 when ACTUAL is not drawn for comparison.
import fs from "node:fs";
import process from "node:process";
import { parseMermaid, productOf } from "./lib.mjs";

const [expectedFile, actualFile] = process.argv.slice(2);
if (!expectedFile || !actualFile) {
	console.error("Usage: node compare-charts.mjs EXPECTED.mmd ACTUAL.mmd");
	process.exit(2);
}

const machine = (regions) => {
	const rs = Object.values(regions);
	return rs.length === 1 ? rs[0] : productOf(regions);
};
const expectedRegions = parseMermaid(fs.readFileSync(expectedFile, "utf8")).regions;
const expected = machine(expectedRegions);
const actual = machine(parseMermaid(fs.readFileSync(actualFile, "utf8")).regions);

const refusals = [
	[(l) => / or …$/.test(l), "an edge label ends in \" or …\"; draw ACTUAL with --all-labels"],
	[(l) => /^\d+(, \d+)*\. /.test(l), "an edge label is a numbered path step; draw ACTUAL with --highlight 0"],
	[(l) => /with the fix\)?$|blocked by the fix$/.test(l), "an edge comes from the fixed model; draw ACTUAL without --fixed-dot"],
];
for (const [bad, why] of refusals) {
	if (actual.transitions.some((t) => bad(t.label))) {
		console.error(`${actualFile}: ${why}`);
		process.exit(2);
	}
}

const edgeSet = (m) => {
	const labeled = new Set();
	const out = new Set();
	for (const t of m.transitions) {
		if (!t.label) continue;
		labeled.add(`${t.from} --> ${t.to}`);
		for (const l of t.label.split(" or ")) out.add(`${t.from} --> ${t.to} : ${l}`);
	}
	for (const t of m.transitions) if (!t.label && !labeled.has(`${t.from} --> ${t.to}`)) out.add(`${t.from} --> ${t.to}`);
	return out;
};
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

// A region state that no combination of the agreed chart's own steps reaches can never be drawn.
const unreached = [];
if (Object.keys(expectedRegions).length > 1) {
	Object.entries(expectedRegions).forEach(([name, r], ri) => {
		const seen = new Set([...expected.states].map((s) => s.split(" | ")[ri]));
		for (const s of r.states) if (!seen.has(s)) unreached.push(`${name}: ${s}`);
	});
}

const rows = [
	["region states the agreed chart's own steps never reach", unreached.sort()],
	["states only in EXPECTED (no path from the start reaches them in the spec, or the spec renamed them)", minus(expected.states, actual.states)],
	["states only in ACTUAL", minus(actual.states, expected.states)],
	["start states only in EXPECTED", minus(expected.initial, actual.initial)],
	["start states only in ACTUAL", minus(actual.initial, expected.initial)],
	["transitions only in EXPECTED (a guard in the spec blocks them, or the spec renamed the step)", minus(edgeSet(expected), edgeSet(actual))],
	["transitions only in ACTUAL", minus(edgeSet(actual), edgeSet(expected))],
].filter(([, xs]) => xs.length > 0);

let differences = 0;
for (const [title, xs] of rows) {
	console.log(`${title}:`);
	for (const x of xs) console.log(`  ${x}`);
	differences += xs.length;
}
console.log(differences === 0 ? "same" : `${differences} difference(s)`);
process.exit(differences === 0 ? 0 : 1);
