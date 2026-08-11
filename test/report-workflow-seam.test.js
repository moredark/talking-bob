const assert = require("node:assert/strict");
const test = require("node:test");
const { MODULE_METADATA } = require("@nestjs/common/constants");
const { installRuntimeSettings } = require("./support/runtime-settings-test-harness");

const { ReportHandler } = require("../dist/modules/telegram/handlers/report.handler");
const { VoiceHandler } = require("../dist/modules/telegram/handlers/voice.handler");
const { TelegramModule } = require("../dist/modules/telegram/telegram.module");
const {
  ReportWorkflowService,
} = require("../dist/modules/telegram/report-workflow.service");
installRuntimeSettings(VoiceHandler);

test("ReportHandler delegates generateClaimedReport to an injected workflow", async () => {
  const unexpectedCall = () => {
    throw new Error("fallback dependency must not be called");
  };
  const delegatedCalls = [];
  const workflow = {
    generateClaimedReport: async (...args) => delegatedCalls.push(args),
  };
  const handler = new ReportHandler(
    {},
    {},
    { completeGeneration: unexpectedCall },
    { getMessages: unexpectedCall },
    {},
    { analyzeSpeech: unexpectedCall },
    undefined,
    undefined,
    workflow,
  );
  const ctx = { update: { update_id: 42 } };
  const claim = {
    responseId: "response-1",
    claimToken: "claim-1",
    claimExpiresAt: new Date("2026-08-09T12:00:00.000Z"),
  };

  await handler.generateClaimedReport(
    ctx,
    "user-prompt-1",
    "Travel",
    "playful",
    claim,
  );

  assert.equal(delegatedCalls.length, 1);
  assert.equal(delegatedCalls[0][0], ctx);
  assert.equal(delegatedCalls[0][1], "user-prompt-1");
  assert.equal(delegatedCalls[0][2], "Travel");
  assert.equal(delegatedCalls[0][3], "playful");
  assert.equal(delegatedCalls[0][4], claim);
});

test("TelegramModule wires the shared report workflow into both handlers", () => {
  const reportDependencies = Reflect.getMetadata("design:paramtypes", ReportHandler);
  const voiceDependencies = Reflect.getMetadata("design:paramtypes", VoiceHandler);
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TelegramModule);

  assert.equal(reportDependencies[8], ReportWorkflowService);
  assert.equal(voiceDependencies[6], ReportWorkflowService);
  assert.equal(providers.includes(ReportWorkflowService), true);
});
