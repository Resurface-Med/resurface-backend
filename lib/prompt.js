/**
 * The question prompt, and the shapes that go with it.
 *
 * Lifted out of the route unchanged so that anything which generates bank
 * questions uses the same words — the route the app calls, and the local
 * script that builds the shared bank from a folder of lectures. A copy in
 * the script would drift the first time either side was edited, and then
 * the bank and the app would quietly be producing different products.
 *
 * Nothing in here is model-specific: it is instructions, five real
 * exemplars from the university's own paper, and a schema.
 */

/**
 * The house style, measured off the Year 1 mock SBA paper (ARU, Jan 2025, 59
 * questions) rather than described from memory. Stems run 10–35 words: up to
 * three sentences of context, then one direct question line. Options are
 * terse — the median is two words, half are one or two — and five in six are
 * noun phrases, not sentences. The paper lists
 * options alphabetically; that is done here in parseQuestions, so the model
 * only has to write them. A third of questions open on a scenario, and half
 * of those are not clinical: a fact, then a question about it.
 *
 * The exemplars are real questions from that paper. Nothing in prose moved
 * Flash-Lite as far as five examples in the exact shape it has to emit.
 */
export const EXEMPLARS = [
  {
    q: "Which form of RNA brings amino acids to the protein synthesis apparatus within a cell?",
    opts: ["mRNA", "miRNA", "rRNA", "siRNA", "tRNA"],
    ans: 4,
    exp: "tRNA carries a specific amino acid on its 3' end and pairs its anticodon with the mRNA codon at the ribosome. It is the adaptor between the nucleotide code and the growing peptide.",
    optExp: ["mRNA carries the coding sequence, not the amino acids.", "miRNA regulates gene expression by silencing transcripts.", "rRNA is a structural and catalytic part of the ribosome.", "siRNA degrades target mRNA; it carries nothing.", ""],
  },
  {
    q: "Gastrin is a hormone released from the stomach that stimulates nearby cells to secrete hydrochloric acid. What kind of signalling best describes this interaction?",
    opts: ["Autocrine", "Endocrine", "Gap junction communication", "Intracrine", "Paracrine"],
    ans: 4,
    exp: "Gastrin from G cells acts on neighbouring parietal and ECL cells by local diffusion. Signalling to adjacent cells without entering the bloodstream is paracrine.",
    optExp: ["Autocrine signals act on the cell that released them.", "Endocrine signals travel via the blood to distant targets.", "Gap junctions pass ions and small molecules directly between cytoplasms.", "Intracrine signalling acts inside the releasing cell.", ""],
  },
  {
    q: "Hexokinase I and glucokinase both catalyse the phosphorylation of glucose to glucose-6-phosphate. KM for hexokinase I is 0.05 mM; KM for glucokinase is 5 mM. What does the difference in KM imply?",
    opts: ["Both enzymes are almost fully saturated at fasting blood glucose", "Glucokinase converts glucose at a higher rate than hexokinase I", "Glucokinase is inhibited by a competitive inhibitor", "Hexokinase I has a higher affinity for glucose than glucokinase", "Hexokinase I is regulated by allosteric interactions"],
    ans: 3,
    exp: "KM is the substrate concentration at half Vmax, so a lower KM means the enzyme reaches half-maximal activity at a lower substrate concentration. Hexokinase I, with a KM a hundred-fold lower, binds glucose far more readily.",
    optExp: ["At ~5 mM glucose hexokinase I is saturated but glucokinase is only half-saturated.", "KM says nothing about Vmax or rate.", "Nothing in the data indicates an inhibitor.", "", "Allosteric regulation cannot be inferred from KM alone."],
  },
  {
    q: "A 36 year old woman presents with an acute bacterial infection. A blood film reports that the most predominant cells have multilobed nuclei and contain a range of enzyme-filled granules. Which cells are these most likely to be?",
    opts: ["Basophils", "Eosinophils", "Lymphocytes", "Monocytes", "Neutrophils"],
    ans: 4,
    exp: "Neutrophils are the first and most numerous responders to acute bacterial infection. Their multilobed nucleus and granules of lysozyme, myeloperoxidase and proteases are the identifying features.",
    optExp: ["Basophils have a bilobed nucleus and are rare on a film.", "Eosinophils have a bilobed nucleus and respond to parasites and allergy.", "Lymphocytes have a single round nucleus and few granules.", "Monocytes have a kidney-shaped nucleus and are less numerous.", ""],
  },
  {
    q: "Which of the following statements about the neuronal action potential is correct?",
    opts: ["An action potential cannot be generated during the absolute refractory period", "Peak of the action potential is associated with closure of voltage-gated potassium channels", "Repolarisation is mediated by sodium efflux", "Transmission velocity is decreased by the presence of myelin", "Voltage-gated sodium channels become insensitive at around −55 mV"],
    ans: 0,
    exp: "During the absolute refractory period voltage-gated sodium channels are inactivated and cannot reopen whatever the stimulus. This sets the maximum firing rate and forces one-way propagation.",
    optExp: ["", "The peak is when potassium channels open, not close.", "Repolarisation is potassium efflux.", "Myelin increases conduction velocity by saltatory conduction.", "−55 mV is threshold, where sodium channels open."],
  },
];


/**
 * The paper's own proportions: two thirds direct or fact-led, one third
 * scenario-led.
 */
export const SHAPE = "per 6 questions: 2 single direct questions (exemplars 1, 5), 2 fact-then-question (exemplars 2, 3), 2 scenario-then-question (exemplar 4). Interleave the shapes; never two scenarios in a row";

/**
 * Questions already in the deck, so a second pass over the same lecture
 * covers new ground.
 *
 * Generating twice from one PDF used to produce the same questions twice:
 * the model is given the material and a count and has never been told what
 * it already wrote. This is the whole fix — it only needs to know.
 *
 * Appended rather than woven in, and only when there is something to avoid,
 * so systemPrompt(n) is byte-identical to what it has always returned.
 * The question style is the product and is not what this changes.
 */
function avoidBlock(stems) {
  return `

ALREADY IN THIS DECK — ${stems.length} question${stems.length === 1 ? "" : "s"} written from this material before
${stems.map(x => `- ${x}`).join("\n")}

These are not material to ask about; they are what has been asked. Cover
ground they do not. A question is a duplicate if a student who could answer
one could answer the other without knowing anything more — rewording, or
swapping which of the same five options is correct, is still a duplicate.
Go to the parts of the material these leave untouched. If the material is
genuinely exhausted, write fewer rather than rephrasing these.`;
}

export function systemPrompt(n, avoid = []) {
  const base = `You write single-best-answer questions for a Year 1 MBChB exam, in the exact style of the university's own papers. Output ONLY JSON matching the schema.

Write ${n} questions. Shape: ${SHAPE}.

GROUNDING — the reason this exists
- Every question is answerable from the uploaded material alone. The correct answer must appear in it.
- Distractors come from the same material: the other structures, enzymes, cells or terms the lecture mentions. This is how the real papers are written.
- Spread questions across the material in proportion to how much of it each topic takes. Do not cluster on one slide, and do not ask about a passing mention.
- Ask what a Year 1 examiner would ask: the named thing, the mechanism, the classification. Not trivia.

STEM
- 10–35 words. Up to three short sentences of context, then ONE direct question line ending in "?". A clinical scenario may reach 50 words.
- No preamble ("In the context of the lecture…"), no restating the lecture, no "which of the following is NOT" more than once in ten.
- Lead-ins from the papers: "Which of the following…", "What is the most likely…", "Which … best describes…", "What is the most appropriate…".
- Ask one thing. If you need "and", it is two questions.
- Never give the answer away. The correct option must not appear in the stem, and the stem must not state the fact the question is asking for. A stem that names the answer and then asks for it is not a question.

OPTIONS
- Five. Terse noun phrases, 1–4 words where possible, never a full sentence. Parallel grammar. The correct one must not be the longest or the most specific.
- The exception is the statement-list shape (exemplar 5): five one-clause statements of similar length. Use it for at most one question in six.
- Do not sort or vary position — the server alphabetises. Set "ordered": true only when the options form a natural sequence (numbers, stages, age bands) that must keep its order.
- Never "all of the above", "none of the above", "both A and B".

EXPLANATIONS
- exp: two sentences on why the correct option is right, teaching the mechanism.
- optExp: one sentence per wrong option on why it is wrong; empty string at the answer index.

UK spelling. SI units. British drug names.

EXEMPLARS — real questions from the university's paper, in the shape you must produce:
${JSON.stringify(EXEMPLARS)}`;
  return avoid.length ? base + avoidBlock(avoid) : base;
}

/**
 * What a question has to look like coming back.
 *
 * Declared to the model rather than only described in the prompt, so malformed
 * output is prevented instead of detected. The old path asked for JSON in
 * prose, stripped markdown fences the model added anyway, and returned a 502
 * when the parse failed — a failure the user saw as "try again".
 *
 * optExp carries an empty string at the answer index rather than null: a null
 * inside a typed array is the one thing schema subsets tend to disagree about,
 * and it is normalised back to null below.
 */
export const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          q: { type: "string" },
          opts: { type: "array", items: { type: "string" } },
          ans: { type: "integer" },
          exp: { type: "string" },
          optExp: { type: "array", items: { type: "string" } },
          ordered: { type: "boolean" },
        },
        required: ["q", "opts", "ans", "exp", "optExp"],
      },
    },
  },
  required: ["questions"],
};

/**
 * The university's papers list options alphabetically (43 of 59 on the Year
 * 1 mock), which is also why they have no position cue. Done here rather
 * than asked of the model: sorting five strings and then re-deriving an
 * index is exactly the step a small model gets wrong, and a wrong index is a
 * wrong answer key. Sequences — Phase 1 to 4, age bands — keep their order.
 */
/**
 * A number at the start of an option, and the unit that follows it.
 * "−7.3 kcal/mol" → { n: -7.3, unit: "kcal/mol" }; "96,500 C/mol" → 96500.
 * Ranges keep their first number ("20–37 °C", "4 to 5 half-lives").
 */
function leadingNumber(text) {
  const m = String(text).match(/^\s*([~<>≤≥]?)\s*([+\-−]?)\s*(\d[\d,]*(?:\.\d+)?)(.*)$/);
  if (!m) return null;
  const n = Number(m[3].replace(/,/g, "")) * (m[2] === "-" || m[2] === "−" ? -1 : 1);
  const unit = m[4].replace(/\b(to|and)\b/gi, "").replace(/[\d.,–−\-\s]/g, "").toLowerCase();
  return Number.isFinite(n) ? { n, unit } : null;
}

export function alphabetise(q, ordered) {
  if (ordered || !Array.isArray(q.opts) || q.opts.length !== 5) return q;
  if (!Number.isInteger(q.ans) || q.ans < 0 || q.ans > 4) return q;
  /* Numbers go smallest first, as the papers print them. Sorted as text
     they came out "1%, 10%, 20%, 5%, 50%" (2026-10-23). Only when all five
     are numbers in the same unit; "1 ms" against "2 seconds" stays
     alphabetical rather than being ordered wrongly by its digits. */
  const nums = q.opts.map(leadingNumber);
  const numeric = nums.every(Boolean) && new Set(nums.map(x => x.unit)).size === 1;
  const idx = [0, 1, 2, 3, 4].sort(numeric
    ? (a, b) => nums[a].n - nums[b].n
    : (a, b) => String(q.opts[a]).localeCompare(String(q.opts[b]), "en", { sensitivity: "base" }),
  );
  return {
    ...q,
    opts: idx.map(i => q.opts[i]),
    ans: idx.indexOf(q.ans),
    optExp: Array.isArray(q.optExp) && q.optExp.length === 5 ? idx.map(i => q.optExp[i]) : q.optExp,
  };
}
