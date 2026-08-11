const assert = require("node:assert/strict");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function sqlParts(query, taggedValues) {
  if (Array.isArray(query)) {
    return { text: query.join("?"), values: taggedValues };
  }
  return {
    text: query.strings.join("?"),
    values: Array.isArray(query.values) ? [...query.values] : taggedValues,
  };
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (Object.hasOwn(expected, "not")) return row[key] !== expected.not;
      if (Object.hasOwn(expected, "in")) return expected.in.includes(row[key]);
      return true;
    }
    if (expected instanceof Date && row[key] instanceof Date) {
      return row[key].getTime() === expected.getTime();
    }
    return row[key] === expected;
  });
}

function selected(row, select) {
  if (!row) return null;
  if (!select) return clone(row);
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, include]) => include)
      .map(([key]) => [key, clone(row[key])]),
  );
}

function createInMemoryPrisma({ prompts = [] } = {}) {
  const state = {
    users: [],
    prompts: prompts.map((prompt, index) => ({
      id: `prompt-${index + 1}`,
      topic: `Topic ${index + 1}`,
      textContent: null,
      audioFileId: null,
      difficulty: "medium",
      tags: [],
      isActive: true,
      sortOrder: index,
      createdAt: new Date(1_700_000_000_000 + index),
      ...clone(prompt),
    })),
    userPrompts: [],
    conversationMessages: [],
    userResponses: [],
    reportDeliveryRequests: [],
    userActivityDays: [],
    operations: [],
  };
  const sequence = { user: 0, userPrompt: 0, message: 0, response: 0, delivery: 0 };
  const nextId = (kind) => `${kind}-${++sequence[kind]}`;
  const now = () => new Date(1_800_000_000_000 + state.operations.length);
  const record = (type, model, details = {}) =>
    state.operations.push({ type, model, ...clone(details) });

  function findUser(where) {
    return state.users.find((row) =>
      where.id ? row.id === where.id : row.telegramId === where.telegramId,
    );
  }

  function findResponse(where) {
    if (where.id) return state.userResponses.find((row) => row.id === where.id);
    return state.userResponses.find((row) => row.userPromptId === where.userPromptId);
  }

  function findDelivery(where) {
    if (where.id) return state.reportDeliveryRequests.find((row) => row.id === where.id);
    const key = where.userResponseId_requestKey;
    return state.reportDeliveryRequests.find(
      (row) => row.userResponseId === key.userResponseId && row.requestKey === key.requestKey,
    );
  }

  const client = {
    state,
    async $transaction(callback) {
      const snapshot = clone(state);
      const sequenceSnapshot = { ...sequence };
      state.operations.push({ type: "transaction", phase: "begin" });
      try {
        const result = await callback(client);
        state.operations.push({ type: "transaction", phase: "commit" });
        return result;
      } catch (error) {
        for (const key of Object.keys(state)) state[key] = snapshot[key];
        Object.assign(sequence, sequenceSnapshot);
        state.operations.push({ type: "transaction", phase: "rollback" });
        throw error;
      }
    },
    async $executeRaw(query, ...taggedValues) {
      const { values } = sqlParts(query, taggedValues);
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
      record("upsert", "userActivityDay", { userId, localDate });
      return 1;
    },
    async $queryRaw(query, ...taggedValues) {
      const { text, values } = sqlParts(query, taggedValues);
      state.operations.push({ type: "sql", text, values: clone(values) });

      if (/ROW_NUMBER\(\) OVER/.test(text) && /FROM "user_prompts"/.test(text)) {
        const userIds = values.filter((value) =>
          typeof value === "string" && state.users.some((user) => user.id === value),
        );
        const activePromptIds = new Set(
          state.prompts.filter((prompt) => prompt.isActive).map((prompt) => prompt.id),
        );
        return userIds.flatMap((userId) =>
          state.userPrompts
            .filter(
              (row) =>
                row.userId === userId &&
                ["pending", "sent"].includes(row.deliveryStatus) &&
                activePromptIds.has(row.promptId),
            )
            .sort(
              (left, right) =>
                right.createdAt.getTime() - left.createdAt.getTime() ||
                right.id.localeCompare(left.id),
            )
            .slice(0, 5)
            .map(({ promptId }) => ({ userId, promptId })),
        );
      }
      if (/FROM "users"/.test(text) && /FOR UPDATE/.test(text)) {
        const id = values.find((value) => state.users.some((row) => row.id === value));
        const user = state.users.find((row) => row.id === id);
        return user ? [clone(user)] : [];
      }
      if (/FROM "user_prompts"/.test(text) && /FOR UPDATE/.test(text)) {
        const id = values[0];
        const row = state.userPrompts.find((item) => item.id === id);
        return row
          ? [{ id: row.id, userId: row.userId, conversationStatus: row.conversationStatus }]
          : [];
      }
      if (/FROM "user_responses"/.test(text)) {
        const byPrompt = /"userPromptId" =/.test(text);
        const row = state.userResponses.find((item) =>
          byPrompt ? item.userPromptId === values[0] : item.id === values[0],
        );
        return row ? [{ id: row.id }] : [];
      }
      if (/FROM "report_delivery_requests"/.test(text)) {
        const row = /"requestKey" =/.test(text)
          ? state.reportDeliveryRequests.find(
              (item) => item.userResponseId === values[0] && item.requestKey === values[1],
            )
          : state.reportDeliveryRequests.find((item) => item.id === values[0]);
        return row ? [{ id: row.id }] : [];
      }
      if (/FROM "user_prompts" up/.test(text) && /claimExpiresAt/.test(text)) return [];
      throw new Error(`Unexpected journey SQL: ${text}`);
    },
    user: {
      async upsert({ where, update, create }) {
        let row = findUser(where);
        if (row) {
          Object.assign(row, update, { updatedAt: now() });
          record("upsert", "user", { id: row.id, branch: "update" });
          return clone(row);
        }
        row = {
          id: nextId("user"),
          username: null,
          dailyPromptEnabled: true,
          dailyPromptHour: 13,
          dailyPromptMinute: 0,
          timezone: "Europe/Moscow",
          agentTone: "friendly",
          lastPromptSentAt: null,
          nextPromptAt: null,
          languageLevel: null,
          status: "active",
          bannedAt: null,
          bannedReason: null,
          createdAt: now(),
          updatedAt: now(),
          ...clone(create),
        };
        state.users.push(row);
        record("upsert", "user", { id: row.id, branch: "create" });
        return clone(row);
      },
      async updateMany({ where, data }) {
        const rows = state.users.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, clone(data), { updatedAt: now() });
        record("updateMany", "user", { count: rows.length, data });
        return { count: rows.length };
      },
      async findUnique({ where }) {
        return clone(findUser(where) ?? null);
      },
      async update({ where, data }) {
        const row = findUser(where);
        assert.ok(row, `Missing user ${JSON.stringify(where)}`);
        Object.assign(row, clone(data), { updatedAt: now() });
        record("update", "user", { id: row.id, data });
        return clone(row);
      },
    },
    prompt: {
      async findFirst({ where, select } = {}) {
        return selected(state.prompts.find((row) => matches(row, where)), select);
      },
      async findUnique({ where }) {
        return clone(state.prompts.find((row) => row.id === where.id) ?? null);
      },
      async findMany({ where, select }) {
        return state.prompts
          .filter((row) => matches(row, where))
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((row) => selected(row, select));
      },
    },
    userPrompt: {
      async create({ data, select }) {
        const row = {
          id: nextId("userPrompt"),
          source: "manual",
          deliveryStatus: "pending",
          createdAt: now(),
          sentAt: null,
          scheduledFor: null,
          scheduledOccurrenceKey: null,
          scheduledLocalDate: null,
          timezoneSnapshot: null,
          claimToken: null,
          claimExpiresAt: null,
          deliveryAttemptedAt: null,
          lastDeliveryErrorCode: null,
          lastDeliveryErrorAt: null,
          conversationStatus: "open",
          conversationClosedAt: null,
          firstUserMessageAt: null,
          ...clone(data),
        };
        state.userPrompts.push(row);
        record("create", "userPrompt", { id: row.id, promptId: row.promptId });
        return selected(row, select);
      },
      async findUnique({ where, select }) {
        return selected(state.userPrompts.find((row) => row.id === where.id), select);
      },
      async findFirst({ where }) {
        const rows = state.userPrompts
          .filter((row) => matches(row, where))
          .sort(
            (left, right) =>
              (right.sentAt?.getTime() ?? 0) - (left.sentAt?.getTime() ?? 0) ||
              right.id.localeCompare(left.id),
          );
        return clone(rows[0] ?? null);
      },
      async update({ where, data }) {
        const row = state.userPrompts.find((item) => item.id === where.id);
        assert.ok(row, `Missing user prompt ${where.id}`);
        Object.assign(row, clone(data));
        record("update", "userPrompt", { id: row.id, data });
        return clone(row);
      },
      async updateMany({ where, data }) {
        const rows = state.userPrompts.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, clone(data));
        record("updateMany", "userPrompt", { count: rows.length, data });
        return { count: rows.length };
      },
    },
    conversationMessage: {
      async findUnique({ where }) {
        const row = where.id
          ? state.conversationMessages.find((item) => item.id === where.id)
          : state.conversationMessages.find(
              (item) => item.telegramUpdateId === where.telegramUpdateId,
            );
        return clone(row ?? null);
      },
      async create({ data }) {
        const row = {
          id: nextId("message"),
          voiceFileId: null,
          telegramUpdateId: null,
          createdAt: now(),
          ...clone(data),
        };
        state.conversationMessages.push(row);
        record("create", "conversationMessage", { id: row.id, role: row.role });
        return clone(row);
      },
      async count({ where }) {
        return state.conversationMessages.filter((row) => matches(row, where)).length;
      },
      async findFirst({ where, orderBy, select }) {
        const descending = orderBy?.[0]?.createdAt === "desc";
        const rows = state.conversationMessages
          .filter((row) => matches(row, where))
          .sort((left, right) => {
            const ordered =
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id);
            return descending ? -ordered : ordered;
          });
        return selected(rows[0], select);
      },
      async findMany({ where }) {
        return state.conversationMessages
          .filter((row) => matches(row, where))
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          )
          .map(clone);
      },
    },
    userResponse: {
      async findUnique({ where }) {
        return clone(findResponse(where) ?? null);
      },
      async findUniqueOrThrow({ where }) {
        const row = findResponse(where);
        assert.ok(row, `Missing user response ${JSON.stringify(where)}`);
        return clone(row);
      },
      async create({ data }) {
        assert.equal(findResponse({ userPromptId: data.userPromptId }), undefined);
        const row = {
          id: nextId("response"),
          voiceFileId: null,
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
          sensitiveDataPurgedAt: null,
          createdAt: now(),
          ...clone(data),
        };
        state.userResponses.push(row);
        record("create", "userResponse", { id: row.id });
        return clone(row);
      },
      async update({ where, data }) {
        const row = findResponse(where);
        assert.ok(row, `Missing user response ${JSON.stringify(where)}`);
        Object.assign(row, clone(data));
        record("update", "userResponse", { id: row.id, data });
        return clone(row);
      },
      async updateMany({ where, data }) {
        const rows = state.userResponses.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, clone(data));
        return { count: rows.length };
      },
    },
    reportDeliveryRequest: {
      async findUnique({ where }) {
        return clone(findDelivery(where) ?? null);
      },
      async create({ data }) {
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
          createdAt: now(),
          updatedAt: now(),
          ...clone(data),
        };
        state.reportDeliveryRequests.push(row);
        record("create", "reportDeliveryRequest", { id: row.id });
        return clone(row);
      },
      async update({ where, data }) {
        const row = findDelivery(where);
        assert.ok(row, `Missing delivery ${JSON.stringify(where)}`);
        Object.assign(row, clone(data), { updatedAt: now() });
        record("update", "reportDeliveryRequest", { id: row.id, data });
        return clone(row);
      },
    },
  };

  return client;
}

module.exports = { createInMemoryPrisma };
