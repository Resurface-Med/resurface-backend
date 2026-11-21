/*
 * Stems that point at the source instead of standing alone (2026-11-21).
 *
 * "Name the prostaglandins mentioned in this lecture" cannot be answered
 * without the lecture in front of you, and a real paper never asks it. The
 * prompt already forbids it ("No preamble …"); Flash-Lite still writes it
 * now and then, so the route drops those stems, as it does giveaways, rather
 * than the prompt being changed (it is frozen; see the question-spec note).
 *
 * Only references to the material are caught. "Listed for surgery" or
 * "a murmur is noted" are clinical words and stay.
 */
const SOURCE = "(?:lecture|lectures|lecture notes|lecture material|lecture materials|slides?|handout|notes|text|source material|session|presentation|document|teaching|module|card)";
const PATTERNS = [
  new RegExp(`\\b(?:this|the|these|that) ${SOURCE}\\b`, "i"),
  new RegExp(`\\b(?:mentioned|listed|named|highlighted|noted|described|stated|covered|discussed|given|shown|included) (?:in|by|within|on|throughout) (?:the|this|these|that) ${SOURCE}\\b`, "i"),
  /\baccording to (?:the|this) (?:lecture|lecturer|notes|slides|text|material)/i,
  /\b(?:the )?lecturer\b/i,
  /\bfrom the lecture\b/i,
];

export function pointsAtSource(stem) {
  const s = typeof stem === "string" ? stem : "";
  return PATTERNS.some(re => re.test(s));
}

/** questions as the route holds them. Returns { kept, removed }. */
export function dropLectureRefs(questions) {
  const kept = [];
  let removed = 0;
  for (const q of questions ?? []) {
    if (pointsAtSource(q?.q)) removed += 1;
    else kept.push(q);
  }
  return { kept, removed };
}
