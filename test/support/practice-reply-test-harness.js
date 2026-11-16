const { VoiceHandler } = require("../../dist/modules/telegram/handlers/voice.handler");
const { PracticeReplyWorkflowService } = require("../../dist/modules/telegram/practice-reply-workflow.service");

// Reuse the existing voice test fixtures while exercising the extracted workflow.
function createVoiceHandler(user, prompt, conversation, quota, whisper, llm, report, config, errorLog, observability, personality, spokenReply) {
  const workflow = new PracticeReplyWorkflowService(user, prompt, conversation, quota, llm, report, errorLog, observability, personality, spokenReply);
  return new VoiceHandler(workflow, whisper, config);
}
module.exports = { createVoiceHandler };
