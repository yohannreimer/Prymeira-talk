const MAX_BYTES = 8 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus", webm: "audio/webm"
};
const acceptedMime = new Set([...Object.values(mimeByExtension), "audio/x-m4a", "audio/x-wav", "audio/mp3", "video/webm"]);
export function getTestUploadMime(file: Pick<File,"name"|"type">) {
  return file.type.split(";")[0].trim().toLowerCase() || mimeByExtension[file.name.split(".").at(-1)?.toLowerCase() ?? ""] || "application/octet-stream";
}
export function validateTestUpload(file: Pick<File,"name"|"type"|"size">) {
  if (!file.size) throw new Error("O arquivo está vazio.");
  if (file.size > MAX_BYTES) throw new Error("O anexo de teste deve ter até 8 MB.");
  if (!acceptedMime.has(getTestUploadMime(file))) throw new Error("Formato não suportado. Envie PDF, imagem ou áudio.");
}
