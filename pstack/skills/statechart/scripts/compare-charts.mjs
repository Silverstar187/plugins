#!/usr/bin/env node
// Compare two Mermaid stateDiagram-v2 charts: states, start states, and labeled transitions.
//
//   node compare-charts.mjs EXPECTED.mmd ACTUAL.mmd
//
// Use it to check that a spec still draws the chart the reader agreed to: EXPECTED is the agreed chart,
// ACTUAL is what tlc-to-chart.mjs drew from the spec. When EXPECTED has parallel regions and ACTUAL
// has one, ACTUAL's states split on " | " into one state per region, in EXPECTED's region order
// (the order chart-to-tla.mjs's mapping writes them). An edge label "a or b" counts as two labels,
// and a highlighted path's step numbers ("2. ") are not part of the label.
// Exits 1 when the charts differ.
import fs from "node:fs";
import process from "node:process";
import { parseMermaid } from "./lib.mjs";

const [expectedFile, actualFile] = process.argv.slice(2);
if (!expectedFile || !actualFile) {
	console.error("Usage: node compare-charts.mjs EXPECTED.mmd ACTUAL.mmd");
	process.exit(2);
}
const expected = parseMermaid(fs.readFileSync(expectedFile, "utf8")).regions;
let actual = parseMermaid(fs.readFileSync(actualFile, "utf8")).regions;

const names = Object.keys(expected);
if (names.length > 1 && Object.keys(actual).length === 1) {
	const [only] = Object.values(actual);
	const split = (s) => {
		const parts = s.split(" | ");
		if (parts.length !== names.length) throw new Error(`state "${s}" does not split into ${names.length} regions on " | "`);
		return parts;
	};
	actual = Object.fromEntries(names.map((n) => [n, { states: new Set(), initial: new Set(), transitions: [] }]));
	for (const s of only.states) split(s).forEach((p, i) => actual[names[i]].states.add(p));
	for (const s of only.initial) split(s).forEach((p, i) => actual[names[i]].initial.add(p));
	for (const t of only.transitions) {
		const [from, to] = [split(t.from), split(t.to)];
		names.forEach((n, i) => {
			if (from[i] !== to[i]) actual[n].transitions.push({ from: from[i], to: to[i], label: t.label });
		});
	}
}

const edgeSet = (r) => {
	const out = new Set();
	for (const t of r.transitions) {
		const labels = t.label.replace(/^\d+(, \d+)*\. /, "").replace(/ or …$/, "").split(" or ");
		for (const l of labels) out.add(`${t.from} --> ${t.to}${l ? ` : ${l}` : ""}`);
	}
	return out;
};
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

let differences = 0;
for (const name of new Set([...names, ...Object.keys(actual)])) {
	const e = expected[name];
	const a = actual[name];
	if (!e || !a) {
		console.log(`Region ${name}: only in ${e ? "EXPECTED" : "ACTUAL"}`);
		differences++;
		continue;
	}
	const rows = [
		["states only in EXPECTED (no path from the start reaches them, or the spec renamed them)", minus(e.states, a.states)],
		["states only in ACTUAL", minus(a.states, e.states)],
		["start states only in EXPECTED", minus(e.initial, a.initial)],
		["start states only in ACTUAL", minus(a.initial, e.initial)],
		["transitions only in EXPECTED", minus(edgeSet(e), edgeSet(a))],
		["transitions only in ACTUAL", minus(edgeSet(a), edgeSet(e))],
	].filter(([, xs]) => xs.length > 0);
	if (rows.length === 0) continue;
	console.log(`Region ${name}:`);
	for (const [title, xs] of rows) {
		console.log(`  ${title}:`);
		for (const x of xs) console.log(`    ${x}`);
		differences += xs.length;
	}
}
console.log(differences === 0 ? "same" : `${differences} difference(s)`);
process.exit(differences === 0 ? 0 : 1);
