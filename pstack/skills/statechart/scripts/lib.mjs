// Shared parsing for the statechart scripts. Node built-ins only.

// ---------- TLA+ values as TLC prints them ----------

export function parseValue(text) {
	const src = text.trim();
	let i = 0;
	const ws = () => {
		while (i < src.length && /\s/.test(src[i])) i++;
	};
	const peek = (s) => src.startsWith(s, i);
	const eat = (s) => {
		ws();
		if (!peek(s)) throw new Error(`expected ${s} at ${i} in ${src}`);
		i += s.length;
	};
	const list = (close, item) => {
		const out = [];
		ws();
		if (peek(close)) {
			i += close.length;
			return out;
		}
		for (;;) {
			out.push(item());
			ws();
			if (peek(",")) {
				i++;
				continue;
			}
			eat(close);
			return out;
		}
	};
	const value = () => {
		ws();
		if (peek("<<")) {
			i += 2;
			return list(">>", value);
		}
		if (peek("{")) {
			i++;
			return list("}", value);
		}
		if (peek("[")) {
			i++;
			const pairs = list("]", () => {
				ws();
				const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
				if (!m) throw new Error(`bad record field at ${i}`);
				i += m[0].length;
				eat("|->");
				return [m[0], value()];
			});
			return Object.fromEntries(pairs);
		}
		if (peek("(")) {
			i++;
			const fn = {};
			for (;;) {
				const k = value();
				eat(":>");
				fn[typeof k === "string" ? k : JSON.stringify(k)] = value();
				ws();
				if (peek("@@")) {
					i += 2;
					continue;
				}
				eat(")");
				return fn;
			}
		}
		if (peek('"')) {
			i++;
			let s = "";
			while (i < src.length && src[i] !== '"') {
				if (src[i] === "\\") i++;
				s += src[i++];
			}
			i++;
			return s;
		}
		const m = /^-?\d+|^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
		if (!m) throw new Error(`bad value at ${i} in ${src}`);
		i += m[0].length;
		if (m[0] === "TRUE") return true;
		if (m[0] === "FALSE") return false;
		return /^-?\d+$/.test(m[0]) ? Number(m[0]) : m[0];
	};
	try {
		const v = value();
		ws();
		return i === src.length ? v : src;
	} catch {
		return src;
	}
}

// One state as TLC prints it: "/\ x = 1" lines, or "x = 1" for one variable.
export function parseState(text) {
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	const conjuncts = [];
	for (const line of lines) {
		if (/^\s*\/\\ /.test(line) || conjuncts.length === 0) conjuncts.push(line.replace(/^\s*\/\\ /, ""));
		else conjuncts[conjuncts.length - 1] += ` ${line.trim()}`;
	}
	const vars = {};
	for (const c of conjuncts) {
		const eq = c.indexOf(" = ");
		if (eq < 0) continue;
		vars[c.slice(0, eq).trim()] = parseValue(c.slice(eq + 3));
	}
	return vars;
}

export function stateKey(vars) {
	return JSON.stringify(Object.keys(vars).sort().map((k) => [k, vars[k]]));
}

// ---------- TLC -dump dot,actionlabels ----------

function unescapeDot(s) {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && i + 1 < s.length) {
			const n = s[++i];
			out += n === "n" ? "\n" : n;
		} else out += s[i];
	}
	return out;
}

export function parseDot(text) {
	const nodes = new Map();
	const edges = [];
	const LABEL = '"((?:[^"\\\\]|\\\\.)*)"';
	const nodeRe = new RegExp(`^(-?\\d+) \\[label=${LABEL}(.*)\\];?\\s*$`);
	const edgeRe = new RegExp(`^(-?\\d+) -> (-?\\d+)(?: \\[label=${LABEL})?`);
	for (const line of text.split("\n")) {
		let m = edgeRe.exec(line);
		if (m) {
			if (m[1] !== m[2]) edges.push({ from: m[1], to: m[2], action: m[3] ? unescapeDot(m[3]) : "" });
			continue;
		}
		m = nodeRe.exec(line);
		if (m) nodes.set(m[1], { id: m[1], vars: parseState(unescapeDot(m[2])), init: /style\s*=\s*filled/.test(m[3]) });
	}
	if (nodes.size === 0) throw new Error("no states found; dump the graph with TLC -dump dot,actionlabels <file>");
	const missing = edges.find((e) => !nodes.has(e.from) || !nodes.has(e.to));
	if (missing) throw new Error(`transition ${missing.from} -> ${missing.to} names a state the file does not define`);
	return { nodes, edges };
}

// ---------- TLC error traces (one per violation; many with -continue) ----------

export function parseTraces(text) {
	const traces = [];
	let invariant = null;
	let current = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inv = /^Error: Invariant (\S+) is violated/.exec(line);
		if (inv) {
			invariant = inv[1];
			continue;
		}
		const head = /^State (\d+): <([^\s>(]+)/.exec(line);
		if (!head) continue;
		const body = [];
		while (i + 1 < lines.length && lines[i + 1].trim() !== "") body.push(lines[++i]);
		const step = { action: head[2] === "Initial" ? null : head[2], vars: parseState(body.join("\n")) };
		if (head[1] === "1") {
			current = { invariant, steps: [] };
			traces.push(current);
		}
		current?.steps.push(step);
	}
	return traces;
}

// ---------- Mermaid stateDiagram-v2 (the subset these scripts write and read) ----------

export function wrap(text, width = 26) {
	const words = String(text).split(/\s+/);
	const rows = [];
	let row = "";
	for (const w of words) {
		if (row && (row + " " + w).length > width) {
			rows.push(row);
			row = w;
		} else row = row ? `${row} ${w}` : w;
	}
	if (row) rows.push(row);
	return rows.join("<br/>");
}

const unwrap = (s) => s.replace(/<br\s*\/?>/g, " ").replace(/\s+/g, " ").trim();

// The scripts draw their legend as a composite with this id. It is not part of the machine.
export const LEGEND_ID = "legend";

// Returns { regions: { name: { states:Set, initial:Set, transitions:[{from,to,label}] } }, nevers }.
// Composite states flatten to "Parent.Child". A transition on a composite leaves from each state
// inside it that has no transition with the same label, and enters at the composite's [*] start.
// One top-level composite split by "--" makes one region per part. Regions nest only at the top.
export function parseMermaid(text) {
	const names = new Map();
	const nevers = [];
	const newPart = () => ({ children: [], transitions: [] });
	const root = { name: "", parts: [newPart()] };
	const stack = [root];
	const part = () => stack[stack.length - 1].parts.at(-1);
	const display = (id) => names.get(id) ?? id;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const never = /^%%\s*never\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)(?:\s+--\s+(.*))?$/.exec(line);
		if (never) {
			nevers.push({ name: never[1], states: never[2].split("&").map((s) => s.trim()), sentence: never[3] ?? "" });
			continue;
		}
		if (!line || line.startsWith("%%") || /^(stateDiagram|direction|classDef|class |note|title|---)/.test(line)) continue;
		let m = /^state\s+"([^"]*)"\s+as\s+([A-Za-z_]\w*)\s*(\{)?\s*$/.exec(line);
		if (!m) {
			const plain = /^state\s+([A-Za-z_]\w*)\s*(\{)?\s*$/.exec(line);
			if (plain) m = [line, null, plain[1], plain[2]];
		}
		if (m) {
			if (m[1] !== null) names.set(m[2], unwrap(m[1]));
			if (m[3]) {
				const node = { name: m[2], parts: [newPart()] };
				part().children.push(node);
				stack.push(node);
			} else part().children.push({ name: m[2], leaf: true });
			continue;
		}
		if (line === "}") {
			if (stack.length === 1) throw new Error("unmatched } in the chart");
			stack.pop();
			continue;
		}
		if (line === "--") {
			stack[stack.length - 1].parts.push(newPart());
			continue;
		}
		m = /^(\[\*\]|[A-Za-z_]\w*)\s*-->\s*(\[\*\]|[A-Za-z_]\w*)(?:\s*:\s*(.*))?$/.exec(line);
		if (m) {
			part().transitions.push({ from: m[1], to: m[2], label: m[3] ? unwrap(m[3]) : "" });
			continue;
		}
		m = /^([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(line);
		if (m) {
			names.set(m[1], unwrap(m[2]));
			part().children.push({ name: m[1], leaf: true });
			continue;
		}
		throw new Error(`cannot read chart line: ${line}`);
	}
	if (stack.length !== 1) throw new Error("the chart has an unclosed {");

	// Ids are global, as in Mermaid: a transition may name a state declared inside another composite.
	// A composite's full name prefixes its children ("Parent.Child"). An id used only in a
	// transition is a plain state in the part where it first appears.
	function region(p) {
		const out = { states: new Set(), initial: new Set(), transitions: [] };
		const info = new Map();
		const declared = new Set();
		(function collect(q) {
			for (const c of q.children) {
				if (c.name === LEGEND_ID) continue;
				declared.add(c.name);
				if (!c.leaf) for (const sub of c.parts) collect(sub);
			}
		})(p);
		const transitions = [];
		const lookup = (id) => {
			const found = info.get(id);
			if (!found) throw new Error(`transition names ${id}, which is not in this region`);
			return found;
		};
		function states(q, prefix, depth) {
			const local = q.children.filter((c) => c.name !== LEGEND_ID);
			for (const t of q.transitions) {
				for (const end of [t.from, t.to]) {
					if (end === "[*]" || declared.has(end)) continue;
					declared.add(end);
					local.push({ name: end, leaf: true });
				}
			}
			const all = [];
			for (const c of local) {
				if (info.has(c.name)) {
					if (local.indexOf(c) !== local.findIndex((x) => x.name === c.name)) continue;
					throw new Error(`state id ${c.name} is declared in two places`);
				}
				const full = `${prefix}${display(c.name)}`;
				if (c.leaf) {
					out.states.add(full);
					info.set(c.name, { all: [full], initial: [full], depth });
					all.push(full);
					continue;
				}
				if (c.parts.length > 1) throw new Error(`${display(c.name)} splits into regions below the top level; make each region a top-level region`);
				const inner = states(c.parts[0], `${full}.`, depth + 1);
				const initial = c.parts[0].transitions.filter((t) => t.from === "[*]").flatMap((t) => lookup(t.to).initial);
				if (initial.length === 0) throw new Error(`${display(c.name)} has no [*] --> start, so a transition into it has nowhere to land`);
				info.set(c.name, { all: inner, initial, depth });
				all.push(...inner);
			}
			for (const t of q.transitions) if (t.from !== "[*]" && t.to !== "[*]") transitions.push(t);
			return all;
		}
		states(p, "", 0);
		for (const t of p.transitions) if (t.from === "[*]") for (const s of lookup(t.to).initial) out.initial.add(s);
		// The deepest source wins: a composite's transition leaves only from states inside it
		// that have no deeper transition with the same label.
		transitions.sort((a, b) => lookup(b.from).depth - lookup(a.from).depth);
		const handled = new Set();
		let pending = [];
		let depth = null;
		for (const t of transitions) {
			const from = lookup(t.from);
			if (from.depth !== depth) {
				for (const h of pending) handled.add(h);
				pending = [];
				depth = from.depth;
			}
			for (const f of from.all) {
				const key = `${f}\u0000${t.label}`;
				if (t.label && handled.has(key)) continue;
				for (const to of lookup(t.to).initial) out.transitions.push({ from: f, to, label: t.label });
				if (t.label) pending.push(key);
			}
		}
		return out;
	}

	const regions = {};
	const top = root.parts[0];
	const machine = top.children.filter((c) => c.name !== LEGEND_ID);
	const parallel = machine.length === 1 && !machine[0].leaf && machine[0].parts.length > 1 && top.transitions.every((t) => t.from === "[*]");
	if (parallel) {
		for (const p of machine[0].parts) {
			const [only] = p.children;
			const holder = p.children.length === 1 && !only.leaf && p.transitions.every((t) => t.from === "[*]" && t.to === only.name) ? only : null;
			if (holder && holder.parts.length > 1) throw new Error(`${display(holder.name)} splits into regions below the top level`);
			regions[holder ? display(holder.name) : `Region${Object.keys(regions).length + 1}`] = region(holder ? holder.parts[0] : p);
		}
	} else regions.Main = region(top);
	return { regions, nevers };
}

export const STATUS_CLASSES = [
	"classDef works fill:#f4f6f7,stroke:#566573,color:#1b2631",
	"classDef wrong fill:#fdedec,stroke:#c0392b,color:#7b241c",
	"classDef fixed fill:#e9f7ef,stroke:#1e8449,color:#145a32",
	"classDef worksPath fill:#f4f6f7,stroke:#1f3a93,stroke-width:4px,color:#1b2631",
	"classDef wrongPath fill:#fdedec,stroke:#1f3a93,stroke-width:4px,color:#7b241c",
	"classDef fixedPath fill:#e9f7ef,stroke:#1f3a93,stroke-width:4px,color:#145a32",
];
