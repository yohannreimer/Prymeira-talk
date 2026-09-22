// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHandoffBrief } from "./useHandoffBrief";
import type { HandoffBriefDto } from "../../../../../packages/shared/src/assistant";

const fetchBrief = vi.hoisted(() => vi.fn());
vi.mock("../../app/api", () => ({ apiGetHandoffBrief: fetchBrief }));

const ready: HandoffBriefDto = { status: "ready", nextAction: "Verifique o material.", summary: "Quatro peças.", contextKey: "one", updatedAt: "2026-09-22T19:00:00Z", error: null };
const getToken = async () => "test";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Probe({ id, activity }: { id: string; activity: string }) {
  const { data } = useHandoffBrief(id, true, activity, getToken);
  return <span>{data?.status ?? "none"}:{data?.nextAction ?? "none"}</span>;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  fetchBrief.mockReset();
});

describe("useHandoffBrief", () => {
  it("does not carry a previous conversation's brief across selection", async () => {
    fetchBrief.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, nextAction: "Faça a proposta.", contextKey: "two" });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(<Probe id="conversation-one" activity="t1" />); });
    expect(container.textContent).toContain("Verifique o material.");
    await act(async () => { root.render(<Probe id="conversation-two" activity="t2" />); });
    expect(container.textContent).toContain("Faça a proposta.");
    expect(container.textContent).not.toContain("Verifique o material.");
  });

  it("requests an updated brief when the latest message changes", async () => {
    fetchBrief.mockResolvedValue(ready);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(<Probe id="conversation-one" activity="t1" />); });
    expect(fetchBrief).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<Probe id="conversation-one" activity="t2" />); });
    expect(fetchBrief).toHaveBeenCalledTimes(2);
  });
});
