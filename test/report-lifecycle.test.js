const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ConversationService,
} = require("../dist/modules/conversation/conversation.service");
const {
  ResponseService,
} = require("../dist/modules/response/response.service");

function copy(row) {
  if (!row) return row;
  return { ...row, chunks: Array.isArray(row.chunks) ? [...row.chunks] : row.chunks };
}

function sqlText(query) {
  return (query.strings || query).join("?");
}

function createFakePrisma(seed = {}) {
  const state = {
    userPrompts: (seed.userPrompts || []).map(copy),
    conversationMessages: (seed.conversationMessages || []).map(copy),
    userResponses: (seed.userResponses || []).map(copy),
    reportDeliveryRequests: (seed.reportDeliveryRequests || []).map(copy),
    userActivityDays: (seed.userActivityDays || []).map(copy),
    operations: [],
  };
  const sequences = { message: 0, response: 0, delivery: 0 };
  let deliveryCreateFailures = seed.deliveryCreateFailures || 0;
  let responseCreateFailures = seed.responseCreateFailures || 0;

  const now = () => new Date();
  const nextId = (kind) => `${kind}-${++sequences[kind]}`;
  const returnRow = (row) => copy(row);

  function findResponse(where) {
    if (where.id) return state.userResponses.find((row) => row.id === where.id);
    if (where.userPromptId) {
      return state.userResponses.find((row) => row.userPromptId === where.userPromptId);
    }
    return undefined;
  }

  function findDelivery(where) {
    if (where.id) {
      return state.reportDeliveryRequests.find((row) => row.id === where.id);
    }
    const compound = where.userResponseId_requestKey;
    return state.reportDeliveryRequests.find(
      (row) =>
        row.userResponseId === compound.userResponseId &&
        row.requestKey === compound.requestKey,
    );
  }

  const client = {
    state,
    async $transaction(callback) {
      state.operations.push({ type: "transaction", phase: "begin" });
      const snapshot = {
        userPrompts: structuredClone(state.userPrompts),
        conversationMessages: structuredClone(state.conversationMessages),
        userResponses: structuredClone(state.userResponses),
        reportDeliveryRequests: structuredClone(state.reportDeliveryRequests),
        userActivityDays: structuredClone(state.userActivityDays),
      };
      try {
        const result = await callback(client);
        state.operations.push({ type: "transaction", phase: "commit" });
        return result;
      } catch (error) {
        for (const key of Object.keys(snapshot)) {
          state[key].splice(0, state[key].length, ...snapshot[key]);
        }
        state.operations.push({ type: "transaction", phase: "rollback" });
        throw error;
      }
    },
    async $executeRaw(query, ...taggedValues) {
      const values = taggedValues;
      const [userId, localDateValue, firstActivityAt, lastActivityAt] = values;
      const localDate = typeof localDateValue === "string"
        ? new Date(localDateValue + "T00:00:00.000Z")
        : localDateValue;
      const existing = state.userActivityDays.find((row) => row.userId === userId && row.localDate.getTime() === localDate.getTime());
      if (existing) {
        existing.firstActivityAt = new Date(Math.min(existing.firstActivityAt.getTime(), firstActivityAt.getTime()));
        existing.lastActivityAt = new Date(Math.max(existing.lastActivityAt.getTime(), lastActivityAt.getTime()));
        existing.messageCount += 1;
      } else {
        state.userActivityDays.push({ userId, localDate, firstActivityAt, lastActivityAt, messageCount: 1 });
      }
      state.operations.push({ type: "execute", model: "userActivityDay", text: sqlText(query), values });
      return 1;
    },
    async $queryRaw(query, ...taggedValues) {
      const text = sqlText(query);
      const values = Array.isArray(query.values) ? [...query.values] : taggedValues;
      state.operations.push({ type: "lock", text, values });
      if (/FROM "user_prompts"/.test(text)) {
        return state.userPrompts
          .filter((row) => row.id === values[0])
          .map(({ id, userId, conversationStatus }) => ({
            id,
            userId,
            conversationStatus,
          }));
      }
      if (/FROM "user_responses"/.test(text)) {
        const field = /"userPromptId" =/.test(text) ? "userPromptId" : "id";
        return state.userResponses
          .filter((row) => row[field] === values[0])
          .map(({ id }) => ({ id }));
      }
      if (/FROM "report_delivery_requests"/.test(text)) {
        return state.reportDeliveryRequests
          .filter((row) => {
            if (/"requestKey" =/.test(text)) {
              return row.userResponseId === values[0] && row.requestKey === values[1];
            }
            return row.id === values[0];
          })
          .map(({ id }) => ({ id }));
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    user: {
      async updateMany({ where, data }) {
        state.operations.push({ type: "updateMany", model: "user", where, data });
        return { count: 1 };
      },
    },
    userPrompt: {
      async updateMany({ where, data }) {
        const row = state.userPrompts.find((item) => item.id === where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        state.operations.push({ type: "updateMany", model: "userPrompt", id: row.id, data });
        return { count: 1 };
      },
      async findUnique({ where }) {
        return returnRow(state.userPrompts.find((row) => row.id === where.id));
      },
      async update({ where, data }) {
        const row = state.userPrompts.find((item) => item.id === where.id);
        assert.ok(row, `missing user prompt ${where.id}`);
        Object.assign(row, data);
        state.operations.push({ type: "update", model: "userPrompt", id: row.id, data });
        return returnRow(row);
      },
    },
    conversationMessage: {
      async findUnique({ where }) {
        const row = where.id
          ? state.conversationMessages.find((item) => item.id === where.id)
          : state.conversationMessages.find(
              (item) => item.telegramUpdateId === where.telegramUpdateId,
            );
        return returnRow(row);
      },
      async create({ data }) {
        const row = {
          id: nextId("message"),
          voiceFileId: null,
          telegramUpdateId: null,
          createdAt: now(),
          ...data,
        };
        state.conversationMessages.push(row);
        state.operations.push({ type: "create", model: "conversationMessage", id: row.id });
        return returnRow(row);
      },
      async count({ where }) {
        return state.conversationMessages.filter(
          (row) =>
            row.userPromptId === where.userPromptId &&
            (!where.role || row.role === where.role),
        ).length;
      },
      async findFirst({ where, orderBy, select }) {
        const rows = state.conversationMessages
          .filter(
            (row) =>
              row.userPromptId === where.userPromptId &&
              (!where.role || row.role === where.role) &&
              (!where.voiceFileId || row.voiceFileId !== null),
          )
          .sort((left, right) => {
            const descending = orderBy?.[0]?.createdAt === "desc";
            const time = left.createdAt.getTime() - right.createdAt.getTime();
            const ordered = time || left.id.localeCompare(right.id);
            return descending ? -ordered : ordered;
          });
        const row = rows[0];
        if (!row) return null;
        if (!select) return returnRow(row);
        return Object.fromEntries(
          Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]),
        );
      },
      async findMany({ where }) {
        return state.conversationMessages
          .filter((row) => row.userPromptId === where.userPromptId)
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          )
          .map(returnRow);
      },
    },
    userResponse: {
      async findUnique({ where }) {
        return returnRow(findResponse(where));
      },
      async findUniqueOrThrow({ where }) {
        const row = findResponse(where);
        if (!row) throw new Error("record not found");
        return returnRow(row);
      },
      async create({ data }) {
        if (responseCreateFailures > 0) {
          responseCreateFailures -= 1;
          throw new Error("injected response create failure");
        }
        assert.equal(
          state.userResponses.some((row) => row.userPromptId === data.userPromptId),
          false,
          "userPromptId must remain unique",
        );
        const row = {
          id: nextId("response"),
          transcript: null,
          analysis: null,
          generationStatus: "generating",
          generatedAt: null,
          lastGenerationErrorCode: null,
          lastGenerationErrorAt: null,
          analysisVersion: null,
          analysisKind: null,
          overallScore: null,
          reportDeliveredAt: null,
          createdAt: now(),
          ...data,
        };
        state.userResponses.push(row);
        state.operations.push({ type: "create", model: "userResponse", id: row.id });
        return returnRow(row);
      },
      async update({ where, data }) {
        const row = findResponse(where);
        assert.ok(row, `missing user response ${JSON.stringify(where)}`);
        Object.assign(row, data);
        state.operations.push({ type: "update", model: "userResponse", id: row.id, data });
        return returnRow(row);
      },
      async updateMany({ where, data }) {
        const matches = state.userResponses.filter((row) => {
          if (row.id !== where.id) return false;
          if (where.generationStatus !== undefined && row.generationStatus !== where.generationStatus) return false;
          if (where.generationClaimToken !== undefined && row.generationClaimToken !== where.generationClaimToken) return false;
          if (where.OR && row.reportDeliveredAt !== null && row.reportDeliveredAt !== undefined && !(row.reportDeliveredAt < where.OR[1].reportDeliveredAt.lt)) return false;
          return true;
        });
        matches.forEach((row) => Object.assign(row, data));
        state.operations.push({ type: "updateMany", model: "userResponse", count: matches.length });
        return { count: matches.length };
      },
      async findMany({ where }) {
        return state.userResponses.filter((row) => row.userId === where.userId).map(returnRow);
      },
    },
    reportDeliveryRequest: {
      async findUnique({ where }) {
        return returnRow(findDelivery(where));
      },
      async create({ data }) {
        if (deliveryCreateFailures > 0) {
          deliveryCreateFailures -= 1;
          throw new Error("injected delivery create failure");
        }
        assert.equal(
          state.reportDeliveryRequests.some(
            (row) =>
              row.userResponseId === data.userResponseId && row.requestKey === data.requestKey,
          ),
          false,
          "delivery request key must remain unique per response",
        );
        const createdAt = now();
        const row = {
          id: nextId("delivery"),
          nextChunkIndex: 0,
          status: "pending",
          claimToken: null,
          claimExpiresAt: null,
          deliveryAttemptedAt: null,
          deliveredAt: null,
          lastDeliveryErrorCode: null,
          lastDeliveryErrorAt: null,
          createdAt,
          updatedAt: createdAt,
          ...data,
          chunks: [...data.chunks],
        };
        state.reportDeliveryRequests.push(row);
        state.operations.push({ type: "create", model: "reportDeliveryRequest", id: row.id });
        return returnRow(row);
      },
      async updateMany({ where, data }) {
        const rows = state.userPrompts.filter((row) => row.id === where.id);
        rows.forEach((row) => Object.assign(row, data));
        state.operations.push({ type: "updateMany", model: "userPrompt", count: rows.length, data });
        return { count: rows.length };
      },
      async update({ where, data }) {
        const row = findDelivery(where);
        assert.ok(row, `missing delivery ${JSON.stringify(where)}`);
        Object.assign(row, data, { updatedAt: now() });
        state.operations.push({
          type: "update",
          model: "reportDeliveryRequest",
          id: row.id,
          data,
        });
        return returnRow(row);
      },
    },
  };

  return client;
}

function prompt(overrides = {}) {
  return {
    id: "prompt-1",
    userId: "user-1",
    conversationStatus: "open",
    conversationClosedAt: null,
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: "seed-message-1",
    userPromptId: "prompt-1",
    role: "user",
    content: "hello",
    voiceFileId: "voice-1",
    telegramUpdateId: 1n,
    createdAt: new Date("2026-08-08T10:00:00.000Z"),
    ...overrides,
  };
}

function generatingResponse(overrides = {}) {
  return {
    id: "response-seed",
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    transcript: null,
    analysis: null,
    generationStatus: "generating",
    generationRequestKey: "request-1",
    generationClaimToken: "old-token",
    generationClaimExpiresAt: new Date(Date.now() + 60_000),
    generationAttemptedAt: new Date(),
    generatedAt: null,
    lastGenerationErrorCode: null,
    lastGenerationErrorAt: null,
    analysisVersion: null,
    analysisKind: null,
    overallScore: null,
    reportDeliveredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function voiceData(index, overrides = {}) {
  return {
    userId: "user-1",
    userPromptId: "prompt-1",
    content: `voice ${index}`,
    voiceFileId: `voice-${index}`,
    telegramUpdateId: BigInt(index),
    generationRequestKey: `auto-${index}`,
    ...overrides,
  };
}

function lockTexts(fake) {
  return fake.state.operations
    .filter((operation) => operation.type === "lock")
    .map((operation) => operation.text);
}

test("voice acceptance deduplicates before the closed gate and the third voice closes and claims once", async () => {
  const fake = createFakePrisma({ userPrompts: [prompt()] });
  const service = new ConversationService(fake);

  const first = await service.acceptVoiceAndMaybeClaimGeneration(voiceData(1));
  const second = await service.acceptVoiceAndMaybeClaimGeneration(voiceData(2));
  const duplicateWhileOpen = await service.acceptVoiceAndMaybeClaimGeneration(voiceData(2));
  assert.equal(duplicateWhileOpen.outcome, "duplicate");
  assert.equal(duplicateWhileOpen.message.id, second.message.id);
  assert.equal(fake.state.conversationMessages.length, 2);
  const third = await service.acceptVoiceAndMaybeClaimGeneration(voiceData(3));
  const duplicateAfterClose = await service.acceptVoiceAndMaybeClaimGeneration(voiceData(2));
  const fourth = await service.acceptVoiceAndMaybeClaimGeneration(voiceData(4));

  assert.equal(first.outcome, "accepted");
  assert.equal(first.generationClaim, null);
  assert.equal(second.userMessageCount, 2);
  assert.equal(third.outcome, "accepted");
  assert.equal(third.userMessageCount, 3);
  assert.ok(third.generationClaim?.claimToken);
  assert.equal(duplicateAfterClose.outcome, "duplicate");
  assert.equal(duplicateAfterClose.message.id, second.message.id);
  assert.equal(fourth.outcome, "closed");
  assert.equal(fake.state.conversationMessages.length, 3);
  assert.equal(fake.state.userResponses.length, 1);
  assert.equal(fake.state.userResponses[0].voiceFileId, "voice-1");
  assert.equal(fake.state.userResponses[0].generationRequestKey, "auto-3");
  assert.equal(fake.state.userPrompts[0].conversationStatus, "closed");
  assert.ok(fake.state.userPrompts[0].conversationClosedAt instanceof Date);
  assert.ok(fake.state.userPrompts[0].firstUserMessageAt instanceof Date);
  assert.equal(fake.state.userActivityDays.length, 1);
  assert.equal(fake.state.userActivityDays[0].messageCount, 3);
  const activityWrites = fake.state.operations.filter((operation) => operation.type === "execute" && operation.model === "userActivityDay");
  assert.equal(activityWrites.length, 3);
  assert.ok(activityWrites.every((operation) => operation.text.includes("?::date")));
  assert.ok(activityWrites.every((operation) => /^\d{4}-\d{2}-\d{2}$/.test(operation.values[1])));
  assert.equal(
    fake.state.operations.filter(
      (operation) => operation.type === "create" && operation.model === "userResponse",
    ).length,
    1,
  );
  assert.equal(
    fake.state.operations.filter(
      (operation) => operation.type === "transaction" && operation.phase === "commit",
    ).length,
    6,
  );
  const promptLocks = lockTexts(fake).filter((text) =>
    /FROM "user_prompts".*FOR UPDATE/.test(text),
  );
  assert.ok(promptLocks.length > 0);
  assert.ok(promptLocks.every((text) => /FOR UPDATE/.test(text)));
});

test("third voice rolls back its message and prompt closure when response creation fails", async () => {
  const fake = createFakePrisma({
    userPrompts: [prompt()],
    conversationMessages: [
      message(),
      message({
        id: "seed-message-2",
        voiceFileId: "voice-2",
        telegramUpdateId: 2n,
        createdAt: new Date("2026-08-08T10:00:01.000Z"),
      }),
    ],
    responseCreateFailures: 1,
  });

  await assert.rejects(
    new ConversationService(fake).acceptVoiceAndMaybeClaimGeneration(voiceData(3)),
    /injected response create failure/,
  );

  assert.equal(fake.state.conversationMessages.length, 2);
  assert.equal(fake.state.userPrompts[0].conversationStatus, "open");
  assert.equal(fake.state.userPrompts[0].conversationClosedAt, null);
  assert.equal(fake.state.userResponses.length, 0);
  assert.equal(
    fake.state.operations.filter(
      (operation) => operation.type === "transaction" && operation.phase === "rollback",
    ).length,
    1,
  );
});

test("manual-first and auto-first serialization both produce exactly one generation owner", async () => {
  const manualFake = createFakePrisma({
    userPrompts: [prompt()],
    conversationMessages: [message()],
  });
  const manualResponse = new ResponseService(manualFake);
  const manualConversation = new ConversationService(manualFake);
  const manual = await manualResponse.claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    generationRequestKey: "manual",
  });
  const afterManual = await manualConversation.acceptVoiceAndMaybeClaimGeneration(voiceData(2));

  assert.equal(manual.outcome, "claimed");
  assert.equal(afterManual.outcome, "closed");
  assert.equal(manualFake.state.userResponses.length, 1);

  const autoFake = createFakePrisma({ userPrompts: [prompt()] });
  const autoConversation = new ConversationService(autoFake);
  const autoResponse = new ResponseService(autoFake);
  await autoConversation.acceptVoiceAndMaybeClaimGeneration(voiceData(1));
  await autoConversation.acceptVoiceAndMaybeClaimGeneration(voiceData(2));
  const auto = await autoConversation.acceptVoiceAndMaybeClaimGeneration(voiceData(3));
  const afterAuto = await autoResponse.claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-3",
    generationRequestKey: "manual-after-auto",
  });

  assert.equal(auto.outcome, "accepted");
  assert.ok(auto.generationClaim);
  assert.equal(afterAuto.outcome, "busy");
  assert.equal(afterAuto.response.id, auto.generationClaim.responseId);
  assert.equal(autoFake.state.userResponses.length, 1);
  assert.ok(
    lockTexts(autoFake).some((text) => /FROM "user_responses".*"userPromptId".*FOR UPDATE/.test(text)),
  );
});

test("manual generation rejects empty dialogs and reports an active lease as busy", async () => {
  const emptyFake = createFakePrisma({ userPrompts: [prompt()] });
  const emptyService = new ResponseService(emptyFake);
  const empty = await emptyService.claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    generationRequestKey: "manual-empty",
  });
  assert.equal(empty.outcome, "no_messages");
  assert.equal(emptyFake.state.userPrompts[0].conversationStatus, "open");
  assert.equal(emptyFake.state.userResponses.length, 0);

  const busyFake = createFakePrisma({
    userPrompts: [prompt({ conversationStatus: "closed" })],
    conversationMessages: [message()],
    userResponses: [generatingResponse()],
  });
  const busy = await new ResponseService(busyFake).claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    generationRequestKey: "another-request",
  });
  assert.equal(busy.outcome, "busy");
  assert.equal(busy.response.generationClaimToken, "old-token");
  assert.ok(lockTexts(busyFake).some((text) => /FROM "user_prompts".*FOR UPDATE/.test(text)));
  assert.ok(lockTexts(busyFake).some((text) => /FROM "user_responses".*FOR UPDATE/.test(text)));
});

test("expired generation is reclaimed, fences the old token, and failed request keys are idempotent", async () => {
  const fake = createFakePrisma({
    userPrompts: [prompt({ conversationStatus: "closed" })],
    conversationMessages: [message()],
    userResponses: [
      generatingResponse({ generationClaimExpiresAt: new Date(Date.now() - 1_000) }),
    ],
  });
  const service = new ResponseService(fake);
  const reclaimed = await service.claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    generationRequestKey: "retry-key",
  });

  assert.equal(reclaimed.outcome, "claimed");
  assert.notEqual(reclaimed.claim.claimToken, "old-token");
  const staleCompletion = await service.completeGeneration({
    responseId: "response-seed",
    claimToken: "old-token",
    transcript: "stale transcript",
    analysis: "stale analysis",
    analysisVersion: 2,
    analysisKind: "model",
    overallScore: 8,
    chunks: ["stale delivery"],
  });
  assert.equal(staleCompletion.outcome, "stale");
  assert.equal(fake.state.reportDeliveryRequests.length, 0);
  assert.equal(await service.failGeneration("response-seed", "old-token", "late failure"), false);
  assert.equal(
    await service.failGeneration("response-seed", reclaimed.claim.claimToken, "Provider / 503"),
    true,
  );
  assert.equal(fake.state.userResponses[0].lastGenerationErrorCode, "provider_503");

  const same = await service.claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    generationRequestKey: "retry-key",
  });
  assert.equal(same.outcome, "failed_same_request");

  const fresh = await service.claimGeneration({
    userId: "user-1",
    userPromptId: "prompt-1",
    voiceFileId: "voice-1",
    generationRequestKey: "intentional-new-key",
  });
  assert.equal(fresh.outcome, "claimed");
  assert.notEqual(fresh.claim.claimToken, reclaimed.claim.claimToken);
  assert.equal(fake.state.userResponses[0].lastGenerationErrorCode, null);
});

test("generation completion atomically saves report metadata and creates the initial delivery claim", async () => {
  const fake = createFakePrisma({
    userResponses: [generatingResponse({ generationRequestKey: "generation-key" })],
    deliveryCreateFailures: 1,
  });
  const service = new ResponseService(fake);
  const completion = {
    responseId: "response-seed",
    claimToken: "old-token",
    transcript: "I went to work.",
    analysis: "Good use of the past tense.",
    analysisVersion: 2,
    analysisKind: "model",
    overallScore: 8,
    chunks: ["part one", "part two"],
  };

  await assert.rejects(
    service.completeGeneration(completion),
    /injected delivery create failure/,
  );
  assert.equal(fake.state.userResponses[0].generationStatus, "generating");
  assert.equal(fake.state.userResponses[0].transcript, null);
  assert.equal(fake.state.userResponses[0].analysis, null);
  assert.equal(fake.state.userResponses[0].generationClaimToken, "old-token");
  assert.equal(fake.state.reportDeliveryRequests.length, 0);
  assert.equal(
    fake.state.operations.filter(
      (operation) => operation.type === "transaction" && operation.phase === "rollback",
    ).length,
    1,
  );

  const completed = await service.completeGeneration(completion);

  assert.equal(completed.outcome, "claimed");
  assert.equal(completed.claim.nextChunkIndex, 0);
  assert.deepEqual(completed.claim.chunks, ["part one", "part two"]);
  assert.deepEqual(
    {
      transcript: fake.state.userResponses[0].transcript,
      analysis: fake.state.userResponses[0].analysis,
      status: fake.state.userResponses[0].generationStatus,
      version: fake.state.userResponses[0].analysisVersion,
      kind: fake.state.userResponses[0].analysisKind,
      score: fake.state.userResponses[0].overallScore,
      token: fake.state.userResponses[0].generationClaimToken,
    },
    {
      transcript: "I went to work.",
      analysis: "Good use of the past tense.",
      status: "generated",
      version: 2,
      kind: "model",
      score: 8,
      token: null,
    },
  );
  assert.equal(fake.state.reportDeliveryRequests.length, 1);
  assert.equal(fake.state.reportDeliveryRequests[0].requestKey, "generation-key");
  assert.deepEqual(fake.state.reportDeliveryRequests[0].chunks, ["part one", "part two"]);
  assert.equal(
    fake.state.operations.filter(
      (operation) => operation.type === "transaction" && operation.phase === "commit",
    ).length,
    1,
  );
  assert.match(lockTexts(fake)[0], /FROM "user_responses".*FOR UPDATE/);
});

test("a begun delivery is ambiguous until its exact attempt advances the cursor and finalizes", async () => {
  const fake = createFakePrisma({
    userResponses: [
      generatingResponse({ generationStatus: "generated", generationClaimToken: null }),
    ],
  });
  const service = new ResponseService(fake);
  const initial = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "delivery-key",
    ["chunk 0", "chunk 1"],
  );
  assert.equal(initial.outcome, "claimed");

  const attempted0 = new Date("2026-08-08T11:00:00.000Z");
  const begun0 = await service.beginDeliveryChunk(
    initial.claim.requestId,
    initial.claim.claimToken,
    attempted0,
  );
  assert.deepEqual(begun0, {
    outcome: "begun",
    chunk: "chunk 0",
    chunkIndex: 0,
    attemptedAt: attempted0,
  });
  const ambiguous = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "delivery-key",
    ["replacement must be ignored"],
  );
  assert.equal(ambiguous.outcome, "ambiguous");

  const beforeRejectedCallbacks = copy(fake.state.reportDeliveryRequests[0]);
  assert.equal(
    (await service.completeDeliveryChunk(initial.claim.requestId, 1, attempted0)).outcome,
    "stale",
  );
  assert.equal(
    (
      await service.completeDeliveryChunk(
        initial.claim.requestId,
        0,
        new Date(attempted0.getTime() + 1),
      )
    ).outcome,
    "stale",
  );
  assert.equal(
    await service.failDeliveryAmbiguous(
      initial.claim.requestId,
      0,
      new Date(attempted0.getTime() + 1),
      "stale callback",
    ),
    false,
  );
  assert.deepEqual(fake.state.reportDeliveryRequests[0], beforeRejectedCallbacks);

  const next = await service.completeDeliveryChunk(initial.claim.requestId, 0, attempted0);
  assert.equal(next.outcome, "claimed_next");
  assert.equal(next.claim.nextChunkIndex, 1);
  assert.notEqual(next.claim.claimToken, initial.claim.claimToken);
  assert.deepEqual(next.claim.chunks, ["chunk 0", "chunk 1"]);

  assert.equal(
    (
      await service.beginDeliveryChunk(
        initial.claim.requestId,
        initial.claim.claimToken,
        new Date("2026-08-08T11:00:00.500Z"),
      )
    ).outcome,
    "stale",
  );
  assert.equal(fake.state.reportDeliveryRequests[0].nextChunkIndex, 1);
  assert.equal(fake.state.reportDeliveryRequests[0].claimToken, next.claim.claimToken);

  const attempted1 = new Date("2026-08-08T11:00:01.000Z");
  const begun1 = await service.beginDeliveryChunk(
    next.claim.requestId,
    next.claim.claimToken,
    attempted1,
  );
  assert.equal(begun1.outcome, "begun");
  assert.equal(begun1.chunk, "chunk 1");
  const final = await service.completeDeliveryChunk(next.claim.requestId, 1, attempted1);
  assert.equal(final.outcome, "delivered");
  assert.equal(final.request.nextChunkIndex, 2);
  assert.ok(final.request.deliveredAt instanceof Date);
  assert.ok(fake.state.userResponses[0].reportDeliveredAt instanceof Date);
  const delivered = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "delivery-key",
    ["ignored"],
  );
  assert.equal(delivered.outcome, "delivered");
  assert.ok(lockTexts(fake).some((text) => /FROM "report_delivery_requests".*FOR UPDATE/.test(text)));
});

test("definite and ambiguous delivery failures diverge, while a new key permits intentional resend", async () => {
  const fake = createFakePrisma({
    userResponses: [
      generatingResponse({ generationStatus: "generated", generationClaimToken: null }),
    ],
  });
  const service = new ResponseService(fake);

  const definite = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "definite-key",
    ["only chunk"],
  );
  const definiteAt = new Date("2026-08-08T12:00:00.000Z");
  await service.beginDeliveryChunk(definite.claim.requestId, definite.claim.claimToken, definiteAt);
  assert.equal(
    await service.failDeliveryDefinite(
      definite.claim.requestId,
      0,
      definiteAt,
      "Telegram 400: blocked",
    ),
    true,
  );
  const failed = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "definite-key",
    ["ignored"],
  );
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.request.lastDeliveryErrorCode, "telegram_400_blocked");

  const uncertain = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "ambiguous-key",
    ["uncertain chunk"],
  );
  const uncertainAt = new Date("2026-08-08T12:01:00.000Z");
  await service.beginDeliveryChunk(uncertain.claim.requestId, uncertain.claim.claimToken, uncertainAt);
  assert.equal(
    await service.failDeliveryAmbiguous(
      uncertain.claim.requestId,
      0,
      uncertainAt,
      "socket reset?",
    ),
    true,
  );
  const ambiguous = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "ambiguous-key",
    ["ignored"],
  );
  assert.equal(ambiguous.outcome, "ambiguous");
  assert.equal(ambiguous.request.status, "pending");
  assert.equal(ambiguous.request.lastDeliveryErrorCode, "socket_reset");

  const resend = await service.createOrClaimDeliveryRequest(
    "response-seed",
    "intentional-resend-key",
    ["fresh resend"],
  );
  assert.equal(resend.outcome, "claimed");
  assert.notEqual(resend.claim.requestId, definite.claim.requestId);
  assert.notEqual(resend.claim.requestId, uncertain.claim.requestId);
  assert.equal(fake.state.reportDeliveryRequests.length, 3);
});
