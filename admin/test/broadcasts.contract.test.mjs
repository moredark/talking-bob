import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const adminRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(adminRoot, path), "utf8");

test("broadcast SPA exposes exact protected routes, navigation and five API methods", () => {
  const router = read("src/router/index.ts");
  const navigation = read("src/components/adminNavigation.ts");
  const api = read("src/api/admin.api.ts");

  assert.match(router, /path:\s*"broadcasts"[^\n]*name:\s*"broadcasts"[^\n]*BroadcastsPage\.vue/);
  assert.match(router, /path:\s*"broadcasts\/new"[^\n]*name:\s*"broadcast-create"[^\n]*BroadcastCreatePage\.vue/);
  assert.match(router, /path:\s*"broadcasts\/:id"[^\n]*name:\s*"broadcast-detail"[^\n]*BroadcastDetailPage\.vue/);
  assert.doesNotMatch(router, /path:\s*"broadcasts[^\n]*meta:\s*\{\s*public:\s*true/);
  assert.match(navigation, /path:\s*"\/broadcasts"[^\n]*label:\s*"Рассылки"/);

  assert.match(api, /previewBroadcast:[\s\S]*apiClient\.post<BroadcastPreview>\("\/admin\/broadcasts\/preview", data\)/);
  assert.match(api, /createBroadcast:[\s\S]*apiClient\.post<BroadcastDetail>\("\/admin\/broadcasts", data\)/);
  assert.match(api, /getBroadcasts:[\s\S]*apiClient\.get<PaginatedResult<BroadcastListItem>>\([\s\S]*"\/admin\/broadcasts"/);
  assert.match(api, /getBroadcastById:[\s\S]*apiClient\.get<BroadcastDetail>\(`\/admin\/broadcasts\/\$\{id\}`/);
  assert.match(api, /cancelBroadcast:[\s\S]*apiClient\.post<BroadcastDetail>\(`\/admin\/broadcasts\/\$\{id\}\/cancel`\)/);
});

test("broadcast creation invalidates previews and enforces UTF-16, Moscow and confirmation UX", () => {
  const page = read("src/pages/BroadcastCreatePage.vue");
  assert.match(page, /const utf16Length = computed\(\(\) => form\.content\.length\)/);
  assert.match(page, /4096 UTF-16/);
  assert.match(page, /const currentSignature = computed/);
  assert.match(page, /watch\(currentSignature[\s\S]*preview\.value = null/);
  assert.match(page, /previewSignature\.value === currentSignature\.value/);
  assert.match(page, /signature === currentSignature\.value[\s\S]*requestError\.value/);
  assert.match(page, /previewBroadcast\(buildPayload\(\)\)/);
  assert.match(page, /createBroadcast\(buildPayload\(\)\)/);
  assert.match(page, /Дата и время \(Москва, UTC\+3\)/);
  assert.match(page, /preview\.normalized\.scheduledAt/);
  assert.match(page, /<AlertDialog\b[\s\S]*<AlertDialogTitle>Создать рассылку\?/);
  assert.match(page, /const canCreate = computed[\s\S]*audienceCount/);
  assert.match(page, /:disabled="creating \|\| !canCreate"/);
  assert.match(page, /<Spinner\b/);
  assert.match(page, /role="alert"/);
  assert.match(page, /:model-value="form\.mode"[\s\S]*@update:model-value="updateMode"/);
  assert.match(page, /function updateMode\(value: unknown\)[\s\S]*value === "immediate"[\s\S]*value === "scheduled"/);
});

test("broadcast list and detail preserve stale protection, server pagination, cancel conflict and purged states", () => {
  const list = read("src/pages/BroadcastsPage.vue");
  const detail = read("src/pages/BroadcastDetailPage.vue");
  assert.match(list, /let requestSequence\s*=\s*0/);
  assert.match(list, /const requestId\s*=\s*\+\+requestSequence/);
  assert.match(list, /adminApi\.getBroadcasts\(page, pagination\.limit, appliedFilters\.value\)/);
  assert.match(list, /<Skeleton\b/);
  assert.match(list, /<StatePanel\b[\s\S]*@retry=/);
  assert.match(list, /<Empty\b/);
  assert.match(list, /<Pagination\b/);

  assert.match(detail, /let requestSequence\s*=\s*0/);
  assert.match(detail, /adminApi\.getBroadcastById\([\s\S]*recipientStatus/);
  assert.match(detail, /response\?\.status === 409[\s\S]*await load\(1\)/);
  assert.match(detail, /await adminApi\.cancelBroadcast\(id\.value\)[\s\S]*await load\(1\)/);
  assert.match(detail, /broadcast\.status === 'queued'/);
  assert.match(detail, /broadcast\.contentPurged \|\| broadcast\.content === null/);
  assert.match(detail, /retention-политик/);
  assert.match(detail, /<Skeleton\b/);
  assert.match(detail, /<StatePanel\b[\s\S]*@retry=/);
  assert.match(detail, /<Empty\b/);
  assert.match(detail, /<Pagination\b/);
  assert.match(detail, /name: 'user-detail'/);
  assert.match(detail, /watch\(id,[\s\S]*broadcast\.value = null[\s\S]*load\(1\)/);
});
