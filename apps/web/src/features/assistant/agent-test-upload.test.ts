import { describe, expect, it } from "vitest";
import { getTestUploadMime, validateTestUpload } from "./agent-test-upload";
describe("test media upload", () => {
  it.each([["pedido.pdf","application/pdf"],["foto.JPG","image/jpeg"],["voz.ogg","audio/ogg"],["voz.m4a","audio/mp4"]])("recognizes %s", (name,mime) => {
    expect(getTestUploadMime({name,type:""})).toBe(mime);
  });
  it("rejects unsupported and oversized files", () => {
    expect(()=>validateTestUpload({name:"script.html",type:"text/html",size:100})).toThrow("Formato");
    expect(()=>validateTestUpload({name:"pedido.pdf",type:"application/pdf",size:9*1024*1024})).toThrow("8 MB");
    expect(()=>validateTestUpload({name:"pedido.pdf",type:"application/pdf",size:0})).toThrow("vazio");
  });
});
