/**
 * Data exhibits (2026-10-20): what a question shows between its stem and
 * its options — an ABG or U&E table, a 2×2, or the paper's own
 * "Investigations:" lines. UKMLA and PLAB use both, and one question can
 * use both at once.
 *
 * A third paper shape is not an exhibit. Observations with the normal
 * range written into the sentence ("pulse rate 150 bpm (95–140)") are
 * the stem.
 *
 * A question may carry `exhibit` as one block, or as an array of blocks
 * when the paper mixes a list and a table:
 *
 *   { kind: "labs", title: "Arterial blood gas (on air)",
 *     rows: [{ name: "pH", value: "7.27", unit: "", range: "7.35 – 7.45", key? }, …],
 *     note: "optional line under the table" }
 *
 *   { kind: "table", title: "…", columns: ["", "DVT present", "DVT absent"],
 *     rows: [["Test positive", "80", "30"], …], keyRows?: number[] }
 *
 *   { kind: "lines", title: "Investigations:",
 *     rows: [
 *       [{ name: "Haemoglobin", value: "101", unit: "g/L", range: "130–175" }],
 *       [{ name: "MCH", value: "24", unit: "pg", range: "27–33" },
 *        { name: "MCV", value: "73", unit: "fL", range: "80–96" }],
 *     ] }
 *
 * A line is one printed row. Two results that share a line on the paper
 * share an entry. Values are strings, written as the exam writes them.
 * No high/low flags: marking what is abnormal answers half the question.
 * `key` on a result (or `keyRows` on a table) is only revealed after answering.
 *
 * The question sentence often comes after the results on the paper. That
 * sentence is `ask` on the question, drawn after the exhibit. Leaving it
 * off keeps the sentence in the stem, which is how the table questions read.
 *
 * `checkExhibit` is why exhibits are data rather than pictures: an exhibit
 * that cannot be true is caught before it is saved. A blood gas whose pH
 * does not follow from its PaCO₂ and bicarbonate, a value outside what a
 * living patient can have, a stated anion gap that does not add up — each
 * is a problem listed by name. A mix is checked as one set of results, so
 * a gas split between the list and the table still has to add up. Pure, so
 * it can be tested.
 */

const num = v => {
  const m = String(v ?? "").replace(/[<>≤≥~]/g, "").replace(/−/g, "-").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const key = name => String(name ?? "").toLowerCase().replace(/[₂2]/g, "2").replace(/[^a-z0-9]/g, "");

/* Find a row by any of its usual names. */
function find(rows, ...names) {
  const want = names.map(key);
  const r = rows.find(r => want.includes(key(r.name)));
  return r ? num(r.value) : null;
}

/* What a living patient can have, roughly — wide on purpose: this is to
   catch a decimal point in the wrong place, not to judge the medicine.
   White cells are left out: a blood count and a CSF count share the name
   and live on different scales. */
const BOUNDS = [
  [["ph"], 6.8, 7.8],
  [["paco2", "pco2"], 1.5, 15],
  [["pao2", "po2"], 2, 70],
  [["bicarbonate", "hco3", "standardbicarbonate"], 2, 60],
  [["sodium", "na"], 100, 185],
  [["potassium", "k"], 1.5, 10],
  [["chloride", "cl"], 60, 140],
  [["urea"], 0.5, 80],
  [["creatinine"], 15, 2500],
  [["glucose", "plasmaglucose", "capillaryglucose", "fastingglucose"], 0.5, 80],
  [["haemoglobin", "hb"], 30, 250],
  [["MCV", "Mean cell volume"], 50, 160],
  [["MCH", "Mean cell haemoglobin", "Mean cell haemoglobin (MCH)"], 12, 45],
  [["Platelets", "Platelet count"], 5, 2500],
  [["calcium", "adjustedcalcium", "correctedcalcium"], 1, 5],
];

function resultsOf(part) {
  if (!part || typeof part !== "object") return [];
  if (part.kind === "labs") return Array.isArray(part.rows) ? part.rows : [];
  if (part.kind === "lines" && Array.isArray(part.rows) && part.rows.every(line => Array.isArray(line))) return part.rows.flat();
  return [];
}

/* The printed shape, not the medicine. A problem here means the numbers
   are not worth reading yet. */
function shapeProblems(ex) {
  const problems = [];
  if (!ex || typeof ex !== "object" || Array.isArray(ex)) return ["No exhibit."];
  if (!ex.title || typeof ex.title !== "string") problems.push("It has no title.");

  if (ex.kind === "table") {
    const cols = ex.columns ?? [];
    if (!Array.isArray(cols) || cols.length < 2) problems.push("A table needs at least two columns.");
    if (!Array.isArray(ex.rows) || !ex.rows.length) problems.push("A table needs rows.");
    else if (ex.rows.some(r => !Array.isArray(r) || r.length !== cols.length)) problems.push("Every row needs one cell per column.");
    return problems;
  }
  if (ex.kind === "lines") {
    const lines = ex.rows ?? [];
    if (!Array.isArray(lines) || !lines.length) return [...problems, "It has no results."];
    if (lines.some(line => !Array.isArray(line) || !line.length)) problems.push("Each line needs at least one result.");
    return problems;
  }
  if (ex.kind !== "labs") return [...problems, `Unknown exhibit kind "${ex.kind}".`];

  if (!Array.isArray(ex.rows) || !ex.rows.length) return [...problems, "It has no results."];
  return problems;
}

function checkResults(rows, problems) {
  if (rows.some(r => !r || !r.name || r.value === undefined || r.value === "")) problems.push("Every result needs a name and a value.");

  for (const [names, lo, hi] of BOUNDS) {
    const v = find(rows, ...names);
    if (v != null && (v < lo || v > hi)) problems.push(`${names[0]} of ${v} is not possible in a living patient.`);
  }

  /* Henderson–Hasselbalch, in kPa: pH = 6.1 + log10(HCO₃ / (0.23 × PaCO₂)). */
  const ph = find(rows, "pH");
  const co2 = find(rows, "PaCO2", "pCO2");
  const hco3 = find(rows, "Bicarbonate", "HCO3", "Standard bicarbonate");
  if (ph != null && co2 != null && hco3 != null && co2 > 0 && hco3 > 0) {
    const expected = 6.1 + Math.log10(hco3 / (0.23 * co2));
    if (Math.abs(expected - ph) > 0.06) {
      problems.push(`The pH does not follow from the PaCO₂ and bicarbonate: they give ${expected.toFixed(2)}, not ${ph}.`);
    }
  }

  /* A stated anion gap must add up: Na − (Cl + HCO₃), give or take. */
  const gap = find(rows, "Anion gap");
  const na = find(rows, "Sodium", "Na"), cl = find(rows, "Chloride", "Cl");
  if (gap != null && na != null && cl != null && hco3 != null) {
    const k = find(rows, "Potassium", "K") ?? 0;
    const a = na - (cl + hco3), b = na + k - (cl + hco3);
    if (Math.abs(gap - a) > 2 && Math.abs(gap - b) > 2) problems.push(`The anion gap does not add up: Na − (Cl + HCO₃) is ${a.toFixed(1)}.`);
  }
  return problems;
}

function checkOne(ex) {
  const shape = shapeProblems(ex);
  const kind = ex?.kind;
  if (kind !== "labs" && kind !== "lines") return shape;
  if (shape.some(s => s === "It has no results." || s.startsWith("Each line"))) return shape;
  return checkResults(resultsOf(ex), shape);
}

function partLabel(part, i) {
  const t = typeof part?.title === "string" ? part.title.replace(/:\s*$/, "") : "";
  return t || `Part ${i + 1}`;
}

/* A table or a lab printout sits beside the options on a wide screen.
   The paper's investigations list stays in the reading column. */
export function exhibitBeside(ex) {
  const parts = Array.isArray(ex) ? ex : ex ? [ex] : [];
  return parts.some(p => p && (p.kind === "labs" || p.kind === "table"));
}

export function checkExhibit(ex) {
  if (!Array.isArray(ex)) return checkOne(ex);
  if (!ex.length) return ["No exhibit."];

  const problems = [];
  const results = [];
  ex.forEach((part, i) => {
    const shape = shapeProblems(part);
    const label = partLabel(part, i);
    for (const p of shape) problems.push(`${label}: ${p}`);
    const blocked = shape.some(s => s === "It has no results." || s.startsWith("Each line") || s.startsWith("Unknown") || s === "No exhibit.");
    if (!blocked && (part?.kind === "labs" || part?.kind === "lines")) results.push(...resultsOf(part));
  });
  return checkResults(results, problems);
}

function resultPhrase(r) {
  return `${r.name} ${r.value}${r.unit ? ` ${r.unit}` : ""}${r.range ? ` (${r.range})` : ""}`;
}

/* The exhibit as plain text, for the AI that explains a question. */
export function exhibitText(ex) {
  if (!ex) return "";
  if (Array.isArray(ex)) return ex.map(exhibitText).filter(Boolean).join("\n\n");
  if (ex.kind === "table") {
    return [ex.title, (ex.columns ?? []).join(" | "), ...(ex.rows ?? []).map(r => r.join(" | ")), ex.note].filter(Boolean).join("\n");
  }
  if (ex.kind === "lines") {
    const lines = (ex.rows ?? []).map(line => (Array.isArray(line) ? line : []).map(resultPhrase).join("    "));
    return [ex.title, ...lines, ex.note].filter(Boolean).join("\n");
  }
  return [
    ex.title,
    ...(ex.rows ?? []).map(r => `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ""}${r.range ? ` (normal ${r.range})` : ""}`),
    ex.note,
  ].filter(Boolean).join("\n");
}
