import { describe, expect, it } from "vitest";
import { parseContactCard } from "./contact-card.js";

describe("parseContactCard", () => {
  it("reads the phone from WhatsApp's grouped TEL line", () => {
    const vcard = "BEGIN:VCARD\nVERSION:3.0\nN:Lapa;Junior;;;\nFN:Junior Lapa\nitem1.TEL;waid=5547991429330:+55 47 99142-9330\nitem1.X-ABLabel:Celular\nEND:VCARD";
    expect(parseContactCard({ displayName: "Junior Lapa", vcard })).toEqual({ fullName: "Junior Lapa", phoneNumber: "5547991429330" });
  });
  it("still reads a plain TEL line", () => {
    expect(parseContactCard({ vcard: "BEGIN:VCARD\nFN:Ana\nTEL;type=CELL:+55 47 3333-4444\nEND:VCARD" })).toEqual({ fullName: "Ana", phoneNumber: "554733334444" });
  });
});
