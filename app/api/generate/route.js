import { allowedOrigin, json, preflight, rateLimited, verify } from "../../../lib/http.js";
import { callGemini, parseJson, upstreamError } from "../../../lib/gemini.js";

/**
 * Set explicitly rather than left to the platform default, because the retries
 * in callGemini are only real if the function outlives them. Generating twenty
 * questions is tens of seconds on its own — Harder, with twice the prompt and
 * a reason written for every wrong option, went past 60 and was killed — so
 * the budget is two attempts of ATTEMPT_MS plus the backoff between them.
 */
export const maxDuration = 120;
const ATTEMPT_MS = 55_000;

/**
 * What makes the call fast, as opposed to what stops it hanging.
 *
 * Gemini 3.x thinks at "medium" when nothing is said, and thinks longest
 * over the longest prompt — Harder's, with its rule set, kept it reasoning
 * for the whole minute before it wrote a token. Standard has never set
 * this and its output was judged right, so Standard's request stays as it
 * was; Harder gets "low", which is enough to pick the nearest distractor
 * with four worked examples in front of it and is not enough to sit and
 * deliberate.
 *
 * The output cap is the other half. Without one a small model that starts
 * repeating inside a JSON array runs until Google's own limit, which from
 * here looks like a hang. A question is ~300 tokens with its explanations;
 * 600 each plus headroom is never reached by a set that is going well and
 * ends one that is not. Thinking tokens count against the same cap, which
 * is why it is only set where the thinking level is known: Standard's
 * medium thinking has no fixed size and a cap could cut its answer off.
 */
const HARDER_THINKING = "low";
const HARDER_TOKENS_PER_QUESTION = 600;
const HARDER_HEADROOM = 4000;

const MAX_COUNT = 20;
const MAX_PER_WINDOW = 10;

// Flash-Lite, and the free tier's shape is the reason rather than the model's.
// Every full Flash model — 3, 3.5, 3.6, 3.7 — is capped at 20 requests a day
// on a free key, which across a hundred users is one lecture each per five
// days. Flash-Lite gets 500 a day and 15 a minute for the same nothing.
//
// The newest models are also the most contended on the free tier: 3.7 Flash
// returned "experiencing high demand" while Flash-Lite was answering normally
// in the same minutes. Fewer people queue for the smaller model.
//
// If billing is ever switched on, GEMINI_MODEL=gemini-3.7-flash: the quota
// stops mattering, paid keys are not queued behind the free tier, and it costs
// about $0.02 a lecture.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

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
const EXEMPLARS = [
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
 * scenario-led. One shape; Harder keeps it and changes only what the
 * options are and what the stem asks for.
 */
const SHAPE = "per 6 questions: 2 single direct questions (exemplars 1, 5), 2 fact-then-question (exemplars 2, 3), 2 scenario-then-question (exemplar 4). Interleave the shapes; never two scenarios in a row";

function systemPrompt(n, harder = false) {
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
  return harder ? base + hardBlock() : base;
}

/**
 * Harder, in one call. Two earlier versions asked for difficulty in prose —
 * as shapes, then as a contract about distractors — and Flash-Lite answered
 * both with longer stems. A third ran a second rewrite pass, which worked
 * but cost two calls against a 500-a-day quota.
 *
 * This one gives the model what moved it in the first place: the paper's
 * own hard questions as exemplars, and rules it can satisfy mechanically
 * rather than judge. Every option the same kind of thing as the answer;
 * the stem asks for a relation, never a name; and optExp must say why a
 * student would pick each wrong option — a model that has to write the
 * temptation chooses tempting distractors. Appended after the base prompt
 * so the Standard bytes are untouched.
 */
const HARD_EXEMPLARS = [
  {
    q: "A patient had a thyroidectomy last week and now has a hoarse voice. Which one of the following structures is most likely to have been injured?",
    opts: ["Ansa cervicalis", "External laryngeal nerve", "Internal laryngeal nerve", "Phrenic nerve", "Recurrent laryngeal nerve"],
    ans: 4,
    exp: "The recurrent laryngeal nerve runs in the tracheo-oesophageal groove behind the thyroid lobes and supplies every intrinsic laryngeal muscle except cricothyroid. Unilateral injury paralyses one vocal fold, giving a hoarse voice.",
    optExp: ["Divided in the approach, but the strap muscles do not move the vocal folds.", "Also at risk beside the superior thyroid artery, but it supplies only cricothyroid, so pitch weakens rather than the voice going hoarse.", "Sensory to the supraglottic larynx; injury causes aspiration, not hoarseness.", "Lies on scalenus anterior, lateral to the field; injury affects the diaphragm.", ""],
  },
  {
    q: "Which of the following lymph nodes are found at the carina?",
    opts: ["Axillary", "Bronchomediastinal", "Bronchopulmonary", "Pulmonary", "Tracheobronchial"],
    ans: 4,
    exp: "The tracheobronchial nodes sit around the bifurcation of the trachea and receive lymph from the bronchopulmonary nodes of both lungs. They drain on to the bronchomediastinal trunks.",
    optExp: ["A familiar node group, but it drains the upper limb and breast.", "Lies higher along the trachea and receives from the tracheobronchial nodes.", "The next station in the chain, but at the hilum, not the carina.", "Within the lung along the bronchi, two stations distal.", ""],
  },
  {
    q: "Which of the following would occur if a neuron was exposed to a two-pore potassium channel blocker?",
    opts: ["Absolute refractory period would shorten", "Delayed repolarisation following action potential", "Inability to trigger action potential", "Resting membrane potential would depolarise", "Resting membrane potential would hyperpolarise"],
    ans: 3,
    exp: "Two-pore domain potassium channels carry the resting potassium leak that holds the membrane near the potassium equilibrium potential. Blocking the leak lets the membrane drift towards the sodium equilibrium potential, so it depolarises.",
    optExp: ["The refractory period is set by sodium channel inactivation, not the leak.", "Tempting if all potassium channels are treated as one, but repolarisation uses voltage-gated channels, a different family.", "A depolarised membrane is nearer threshold, not further from it.", "Hyperpolarisation would need more potassium efflux; blocking the leak gives less.", ""],
  },
  {
    q: "An individual has arterial hypoxaemia; PaO2 = 50 mmHg (normal 75–100 mmHg). Which possible cause of this hypoxaemia would cause the largest elevation in arterial PCO2?",
    opts: ["Diffusion impairment", "High altitude", "Hypoventilation", "Physiological shunt", "Pulmonary embolism"],
    ans: 2,
    exp: "Alveolar ventilation determines PaCO2 directly, so hypoventilation is the only cause of hypoxaemia that raises PaCO2 in step with the fall in PaO2. Every other mechanism leaves ventilation intact or increased.",
    optExp: ["CO2 diffuses twenty times more readily than O2, so PaCO2 stays normal.", "Hypoxic drive raises ventilation, so PaCO2 falls.", "Tempting because shunt seems to affect both gases, but ventilated units clear the CO2.", "Embolism causes hyperventilation and a low PaCO2.", ""],
  },
];

function hardBlock() {
  return `

HARDER — this set is for students who already know the lecture. It overrides anything above that conflicts. Keep the shape mix. Do not lengthen stems: length is not difficulty. Difficulty comes from the options and from what the stem asks.

OPTIONS
- All five options are the same kind of thing as the answer — five nerves, five cartilages, five enzymes, five cell types, five node groups — and all five are named in the material. A student who has only recognised the topic must be unable to eliminate any of them.
- Choose the four nearest the answer: the adjacent structure, the paired or opposite nerve, the previous and next step in the pathway, the other members of the same class in the material.
- The correct answer must not be the most prominent term on its slide, and must not be the longest or most specific option.

STEM
- Ask for a relation or a consequence, never a name in isolation: what X supplies; what is lost when X is damaged; what lies immediately medial, deep or inferior to X; what a value implies; which is the exception.
- Where the shape calls for a scenario, give the finding and make the student infer the structure (hoarse voice → the nerve). Never name the structure and ask what it does.
- The stem must not contain the word that names the answer.

EXPLANATIONS
- optExp: for each wrong option, one short sentence: why a student would pick it, then why it is wrong. If you cannot say why it would be picked, it is not close enough — choose another option from the material. Keep every explanation as short as the exemplars'.

HARD EXEMPLARS — real questions from the paper at this level. Match them:
${JSON.stringify(HARD_EXEMPLARS)}`;
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
const QUESTION_SCHEMA = {
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
 * The client speaks Anthropic content blocks and will keep doing so.
 *
 * Translating here rather than changing the wire format means the app and this
 * endpoint never have to deploy together, and the next provider is another
 * function in this file rather than a change in two repositories.
 */
function toGeminiInput(userContent) {
  return userContent.map(block => {
    if (block?.type === "text") return { type: "text", text: block.text };

    const src = block?.source;
    if (src?.type === "base64" && src.data) {
      return {
        type: block.type === "image" ? "image" : "document",
        data: src.data,
        mime_type: src.media_type,
      };
    }
    return null;
  }).filter(Boolean);
}

async function callAnthropic({ apiKey, userContent, n, harder }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      system: systemPrompt(n, harder),
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, message: err?.error?.message };
  }

  const data = await r.json();
  return { ok: true, text: data.content?.[0]?.text || "" };
}

/**
 * Accepts either a bare array or the schema's { questions: [...] } wrapper, and
 * tolerates markdown fences. The schema should make fences impossible, but the
 * Anthropic path has no schema and this costs three lines.
 */
function parseQuestions(text) {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list)) return null;

  // The app and the question bank both expect null at the answer index; the
  // schema asks for an empty string there because a nullable member inside a
  // typed array is the part schema subsets disagree about.
  return list.map(q => {
    const optExp = Array.isArray(q?.optExp)
      ? q.optExp.map((e, i) => (i === q.ans || e === "" ? null : e))
      : q?.optExp;
    const { ordered, ...rest } = q ?? {};
    return alphabetise({ ...rest, optExp }, ordered);
  });
}

/**
 * The university's papers list options alphabetically (43 of 59 on the Year
 * 1 mock), which is also why they have no position cue. Done here rather
 * than asked of the model: sorting five strings and then re-deriving an
 * index is exactly the step a small model gets wrong, and a wrong index is a
 * wrong answer key. Sequences — Phase 1 to 4, age bands — keep their order.
 */
function alphabetise(q, ordered) {
  if (ordered || !Array.isArray(q.opts) || q.opts.length !== 5) return q;
  if (!Number.isInteger(q.ans) || q.ans < 0 || q.ans > 4) return q;
  const idx = [0, 1, 2, 3, 4].sort((a, b) =>
    String(q.opts[a]).localeCompare(String(q.opts[b]), "en", { sensitivity: "base" }),
  );
  return {
    ...q,
    opts: idx.map(i => q.opts[i]),
    ans: idx.indexOf(q.ans),
    optExp: Array.isArray(q.optExp) && q.optExp.length === 5 ? idx.map(i => q.optExp[i]) : q.optExp,
  };
}

export async function OPTIONS(req) {
  return preflight(req);
}

export async function POST(req) {
  const origin = allowedOrigin(req.headers.get("origin"));

  // A shared access code couldn't be revoked for one person and told us
  // nothing about who was calling. The session token does both: Supabase
  // verifies the signature, and we get a user id to rate limit against.
  const user = await verify(req);
  if (!user) return json({ error: "Sign in to generate questions." }, 401, origin);

  // Whichever key is set decides the provider. Gemini wins when both are.
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !anthropicKey) {
    return json({ error: "Server is missing GEMINI_API_KEY." }, 500, origin);
  }

  if (rateLimited("generate", user.id, MAX_PER_WINDOW)) {
    return json({ error: "Slow down — too many generations. Try again in a minute." }, 429, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request body." }, 400, origin); }

  const { userContent, count = 5, harder = false } = body || {};
  if (!Array.isArray(userContent) || userContent.length === 0) {
    return json({ error: "No content to generate from." }, 400, origin);
  }

  const n = Math.min(Math.max(parseInt(count) || 5, 1), MAX_COUNT);
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  try {
    const input = toGeminiInput(userContent);
    const started = Date.now();
    const result = geminiKey
      ? await callGemini({
          apiKey: geminiKey,
          model,
          system: systemPrompt(n, harder === true),
          input,
          schema: QUESTION_SCHEMA,
          ...(harder === true && {
            thinkingLevel: HARDER_THINKING,
            maxOutputTokens: n * HARDER_TOKENS_PER_QUESTION + HARDER_HEADROOM,
          }),
          timeoutMs: ATTEMPT_MS,
        })
      : await callAnthropic({ apiKey: anthropicKey, userContent, n, harder: harder === true });

    // One line per call so the next slow one can be read off the logs
    // rather than reasoned about.
    console.log(`generate n=${n} harder=${harder === true} ${result.ok ? "ok" : result.status} ${Date.now() - started}ms`);
    if (!result.ok) return upstreamError(result, origin, json, "generating");

    const questions = parseQuestions(result.text);
    if (!questions) {
      return json({ error: "The model returned invalid JSON. Try again." }, 502, origin);
    }

    return json({ questions }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Generation failed." }, 500, origin);
  }
}
