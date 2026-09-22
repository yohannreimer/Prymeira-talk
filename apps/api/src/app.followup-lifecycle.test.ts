import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMock = vi.hoisted(() => ({
  processDueFollowups: vi.fn(),
  start: vi.fn(),
  stop: vi.fn()
}));
const createConversationFollowupSchedulerMock = vi.hoisted(() => vi.fn(() => schedulerMock));

vi.mock("./modules/followups/conversation-followup-scheduler.js", () => ({
  createConversationFollowupScheduler: createConversationFollowupSchedulerMock
}));

import { buildApp } from "./test/build-app.js";

describe("conversation follow-up scheduler lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the scheduler when JEV is configured and stops it when the app closes", async () => {
    const app = await buildApp(
      { JEV_API_KEY: "jev-test-key" },
      { prismaEnabled: true }
    );

    try {
      expect(createConversationFollowupSchedulerMock).toHaveBeenCalledTimes(1);
      expect(schedulerMock.start).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }

    expect(schedulerMock.stop).toHaveBeenCalledTimes(1);
  });

  it("does not create an automatic delivery scheduler when JEV is unavailable", async () => {
    const app = await buildApp({}, { prismaEnabled: true });

    try {
      expect(createConversationFollowupSchedulerMock).not.toHaveBeenCalled();
      expect(schedulerMock.start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }

    expect(schedulerMock.stop).not.toHaveBeenCalled();
  });
});
