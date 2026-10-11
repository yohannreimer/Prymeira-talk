import { DEFAULT_MEETING_REMINDERS } from "@prymeira-talk/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MeetingRemindersEditor, splitMinutesBefore, validateMeetingReminders } from "./MeetingRemindersEditor";

describe("MeetingRemindersEditor", () => {
  it("shows the default reminder one hour before the call", () => {
    const html = renderToStaticMarkup(<MeetingRemindersEditor value={DEFAULT_MEETING_REMINDERS} onChange={vi.fn()} />);

    expect(html).toContain("Mensagens antes da call");
    expect(html).toContain("Lembrete 1: quanto tempo antes");
    expect(html).toContain('value="hours" selected=""');
    expect(html).toContain("Passando pra lembrar da nossa call");
    expect(html).toContain("Adicionar lembrete");
  });

  it("hides the steps when reminders are off", () => {
    const html = renderToStaticMarkup(<MeetingRemindersEditor value={{ enabled: false, steps: [] }} onChange={vi.fn()} />);

    expect(html).not.toContain("Adicionar lembrete");
  });

  it("shows minutes in the largest whole unit", () => {
    expect(splitMinutesBefore(180)).toEqual({ amount: 3, unit: "hours" });
    expect(splitMinutesBefore(1440)).toEqual({ amount: 1, unit: "days" });
    expect(splitMinutesBefore(45)).toEqual({ amount: 45, unit: "minutes" });
  });

  it("explains what is wrong in plain language", () => {
    expect(validateMeetingReminders(DEFAULT_MEETING_REMINDERS)).toBeNull();
    expect(validateMeetingReminders({ enabled: true, steps: [{ minutesBefore: 2, messages: [{ text: "Oi" }] }] }))
      .toBe("Cada lembrete precisa sair entre 5 minutos e 7 dias antes da call.");
    expect(validateMeetingReminders({ enabled: true, steps: [{ minutesBefore: 60, messages: [{ text: "" }] }] }))
      .toBe("Escreva um texto ou informe o link de um arquivo.");
    expect(validateMeetingReminders({
      enabled: true,
      steps: [{ minutesBefore: 60, messages: [{ text: "a" }] }, { minutesBefore: 60, messages: [{ text: "b" }] }]
    })).toBe("Dois lembretes não podem ter a mesma antecedência.");
  });
});
