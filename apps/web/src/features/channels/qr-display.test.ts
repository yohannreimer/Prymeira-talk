import { describe, expect, it } from "vitest";
import { getQrDisplaySource, getQrImageSrc } from "./qr-display";

describe("QR display helpers", () => {
  it("uses Evolution image data URLs directly", () => {
    expect(getQrImageSrc("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg")).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"
    );
  });

  it("wraps raw PNG base64 as an image data URL", () => {
    expect(getQrImageSrc("iVBORw0KGgoAAAANSUhEUg")).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"
    );
  });

  it("leaves textual QR payloads for fallback rendering", () => {
    expect(getQrImageSrc("2@qr-payload")).toBeNull();
  });

  it("classifies textual QR payloads for generated QR rendering", () => {
    expect(getQrDisplaySource("2@qr-payload")).toEqual({
      kind: "payload",
      payload: "2@qr-payload"
    });
  });
});
