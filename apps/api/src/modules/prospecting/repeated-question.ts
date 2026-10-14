const STOPWORDS = new Set(["que", "para", "pra", "com", "uma", "por", "dos", "das", "aos", "voce", "voces", "isso", "essa", "esse", "dessa", "desse",
  "aqui", "ai", "tudo", "bem", "como", "qual", "quais", "sobre", "mais", "seu", "sua", "seus", "suas", "nos", "nas", "pelo", "pela", "tem", "sao"]);

function words(text: string) {
  return new Set(text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !STOPWORDS.has(word)) ?? []);
}

function questions(text: string) {
  return (text.match(/[^.!?\n]*\?/g) ?? []).map((question) => question.trim()).filter(Boolean);
}

/** Returns a question in `reply` that we already asked in this conversation, if any.
 * Prospects read a re-asked question as a bot that did not listen. */
export function findRepeatedQuestion(reply: string, previousOutbound: readonly string[]) {
  const asked = previousOutbound.flatMap(questions).map(words).filter((set) => set.size >= 3);
  for (const question of questions(reply)) {
    const current = words(question);
    if (current.size < 3) continue;
    for (const previous of asked) {
      const shared = [...current].filter((word) => previous.has(word)).length;
      if (shared / Math.min(current.size, previous.size) >= 0.6) return question;
    }
  }
  return null;
}
