import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const adminRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(adminRoot, path), "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sourceFiles(directory) {
  const root = join(adminRoot, directory);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(relative(adminRoot, path))
      : [path];
  });
}

test("router preserves the exact admin route set and auth guards", () => {
  const source = read("src/router/index.ts");
  const declaredPaths = [...source.matchAll(/\{\s*path:\s*"([^"]*)"/g)].map(
    ([, path]) => path,
  );

  assert.deepEqual(declaredPaths, [
    "/login",
    "/",
    "",
    "users",
    "users/:id",
    "prompts",
    "topics",
    "error-logs",
    "audit-logs",
    "audit-logs/:id",
    "sessions",
    "sessions/:id",
    "settings",
    "broadcasts",
    "broadcasts/new",
    "broadcasts/:id",
    "/:pathMatch(.*)*",
  ]);
  assert.match(source, /path:\s*"\/login"[\s\S]*meta:\s*\{\s*public:\s*true\s*\}/);
  assert.match(source, /path:\s*"\/:pathMatch\(\.\*\)\*"\s*,\s*redirect:\s*"\/"/);
  assert.match(source, /if\s*\(!to\.meta\.public\s*&&\s*!isAuthenticated\.value\)[\s\S]*name:\s*"login"[\s\S]*redirect:\s*to\.fullPath/);
  assert.match(source, /to\.name\s*===\s*"login"\s*&&\s*isAuthenticated\.value[\s\S]*name:\s*"dashboard"/);
});

test("admin API preserves endpoint methods and default pagination", () => {
  const source = read("src/api/admin.api.ts");
  const contracts = [
    ["get", '"/admin/dashboard"'],
    ["get", '"/admin/analytics"'],
    ["get", '"/admin/users"'],
    ["get", "`/admin/users/${id}`"],
    ["patch", "`/admin/users/${id}`"],
    ["post", "`/admin/users/${id}/reset-progress`"],
    ["get", '"/admin/topics"'],
    ["get", '"/admin/prompts"'],
    ["get", "`/admin/prompts/${id}`"],
    ["post", '"/admin/prompts"'],
    ["patch", "`/admin/prompts/${id}`"],
    ["delete", "`/admin/prompts/${id}`"],
    ["get", '"/admin/error-logs"'],
    ["get", "`/admin/error-logs/${id}`"],
    ["delete", '"/admin/error-logs/old"'],
    ["get", '"/admin/audit-logs"'],
    ["get", "`/admin/audit-logs/${id}`"],
    ["get", '"/admin/sessions"'],
    ["get", "`/admin/sessions/${id}`"],
    ["get", '"/admin/settings"'],
    ["patch", '"/admin/settings/product"'],
    ["patch", '"/admin/settings/infrastructure"'],
    ["post", '"/admin/broadcasts/preview"'],
    ["post", '"/admin/broadcasts"'],
    ["get", '"/admin/broadcasts"'],
    ["get", "`/admin/broadcasts/${id}`"],
    ["post", "`/admin/broadcasts/${id}/cancel`"],
  ];

  for (const [method, path] of contracts) {
    assert.match(
      source,
      new RegExp(`apiClient\\.${method}(?:<[^\\n]+>)?\\(\\s*${escapeRegExp(path)}`),
      `expected ${method.toUpperCase()} ${path}`,
    );
  }

  assert.match(source, /getUsers:\s*async\s*\(\s*page:\s*number\s*=\s*1,\s*limit:\s*number\s*=\s*20/);
  assert.match(source, /getPrompts:\s*async\s*\(\s*page:\s*number\s*=\s*1,\s*limit:\s*number\s*=\s*20/);
  assert.match(source, /getErrorLogs:\s*async\s*\(\s*page:\s*number\s*=\s*1,\s*limit:\s*number\s*=\s*50/);
  assert.match(source, /getAuditLogs:\s*async\s*\(\s*page:\s*number\s*=\s*1,\s*limit:\s*number\s*=\s*50/);
  assert.match(source, /getSessions:\s*async\s*\(\s*page:\s*number\s*=\s*1,\s*limit:\s*number\s*=\s*50/);
  assert.match(source, /clearOldErrorLogs:\s*async\s*\(days:\s*number\s*=\s*30\)/);
  assert.equal((source.match(/params:\s*\{\s*page,\s*limit/g) ?? []).length, 6);
  assert.match(source, /params:\s*\{\s*days\s*\}/);
});

test("error-log SPA contract exposes operational fields and correlation filtering", () => {
  const api = read("src/api/admin.api.ts");
  const types = read("src/types/index.ts");
  const page = read("src/pages/ErrorLogsPage.vue");

  for (const field of ["operation", "correlationId", "statusCode", "retryable", "latencyMs", "errorKind"]) {
    assert.match(types, new RegExp(`\\b${field}\\??:`), `ErrorLogItem must expose ${field}`);
  }
  assert.match(api, /getErrorLogs:[\s\S]*correlationId\?:\s*string[\s\S]*params:\s*\{\s*page,\s*limit,\s*type,\s*service,\s*correlationId\s*\}/);
  assert.match(page, /typeof route\.query\.correlationId\s*===\s*"string"/);
  assert.match(page, /getErrorLogs\([\s\S]*correlationId\.value/);
  assert.match(page, /watch\(\(\)\s*=>\s*route\.query\.correlationId[\s\S]*load\(1\)/);
});

test("audit-log SPA contract exposes typed list, detail, filters, and protected routes", () => {
  const api = read("src/api/admin.api.ts");
  const types = read("src/types/index.ts");
  const router = read("src/router/index.ts");
  const navigation = read("src/components/adminNavigation.ts");

  const listItem = types.match(
    /export interface AdminAuditListItem\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(listItem, "AdminAuditListItem must remain declared");
  for (const field of [
    "id",
    "actorId",
    "actorUsername",
    "action",
    "entityType",
    "entityId",
    "outcome",
    "requestId",
    "correlationId",
    "failureCode",
    "createdAt",
  ]) {
    assert.match(listItem, new RegExp(`\\b${field}\\??:`));
  }

  assert.match(
    types,
    /export interface AdminAuditDetail extends AdminAuditListItem\s*\{[\s\S]*\bbefore:\s*Record<string, unknown>\s*\|\s*null;[\s\S]*\bafter:\s*Record<string, unknown>\s*\|\s*null;/,
  );
  assert.match(
    api,
    /getAuditLogs:[\s\S]*filters:\s*AuditLogFilters\s*=\s*\{\}[\s\S]*params:\s*\{\s*page,\s*limit,\s*actorId,\s*action,\s*entityType,\s*entityId,\s*outcome,\s*from,\s*to,/,
  );
  assert.match(api, /getAuditLogById:[\s\S]*apiClient\.get<AdminAuditDetail>\(\s*`\/admin\/audit-logs\/\$\{id\}`/);

  assert.match(
    router,
    /path:\s*"audit-logs"[^\n]*name:\s*"audit-logs"[^\n]*AuditLogsPage\.vue/,
  );
  assert.match(
    router,
    /path:\s*"audit-logs\/:id"[^\n]*name:\s*"audit-log-detail"[^\n]*AuditLogDetailPage\.vue/,
  );
  assert.doesNotMatch(
    router,
    /path:\s*"audit-logs(?:"|\/:id")[^\n]*meta:\s*\{\s*public:\s*true/,
  );
  assert.match(navigation, /path:\s*"\/audit-logs"[^\n]*label:\s*"Аудит"/);
});

test("audit pages preserve server filters and complete request states", () => {
  const list = read("src/pages/AuditLogsPage.vue");
  const detail = read("src/pages/AuditLogDetailPage.vue");

  assert.match(list, /<FieldGroup\b[\s\S]*<Field\b/);
  assert.match(list, /<SelectContent>[\s\S]*<SelectGroup>[\s\S]*<SelectItem\b/);
  assert.match(list, /<form\b[^>]*@submit\.prevent="applyFilters"[^>]*@reset\.prevent="resetFilters"/);
  assert.match(list, /<Button\b[^>]*type="reset"[^>]*>[^]*Сбросить/);
  assert.match(list, /<Button\b[^>]*type="submit"[^>]*>[^]*Применить/);
  assert.match(list, /function applyFilters\(\)[\s\S]*appliedFilters\.value\s*=\s*buildFilters\(\)[\s\S]*load\(1\)/);
  assert.match(list, /function resetFilters\(\)/);
  assert.match(list, /let requestSequence\s*=\s*0/);
  assert.match(list, /const requestId\s*=\s*\+\+requestSequence/);
  assert.match(list, /<Skeleton\b/);
  assert.match(list, /<StatePanel\b[\s\S]*@retry=/);
  assert.match(list, /<Empty\b/);
  assert.match(list, /<Pagination\b/);

  assert.match(detail, /adminApi\.getAuditLogById\(id\.value\)/);
  assert.match(detail, /<Skeleton\b/);
  assert.match(detail, /<StatePanel\b[\s\S]*@retry=/);
  assert.match(detail, /import\s*\{\s*isAxiosError\s*\}\s*from\s*"axios"/);
  assert.match(detail, /status\s*===\s*404[\s\S]*"not-found"/);
  assert.match(detail, /status\s*===\s*401[\s\S]*"unauthorized"/);
  assert.match(detail, /status\s*>=\s*500[\s\S]*"server"/);
  assert.match(detail, /!error\.response[\s\S]*"network"/);
  assert.match(detail, /:title="errorTitle"[\s\S]*:description="errorDescription"/);
  assert.match(detail, /JSON\.stringify\(value,\s*null,\s*2\)/);
  assert.match(detail, /log\.before/);
  assert.match(detail, /log\.after/);
});

test("session SPA contract mirrors list and sensitive detail DTOs", () => {
  const api = read("src/api/admin.api.ts");
  const types = read("src/types/index.ts");
  const router = read("src/router/index.ts");
  const navigation = read("src/components/adminNavigation.ts");
  const userDetail = read("src/pages/UserDetailPage.vue");

  const listItem = types.match(
    /export interface AdminSessionListItem\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(listItem, "AdminSessionListItem must remain declared");
  for (const field of [
    "id",
    "user",
    "prompt",
    "source",
    "deliveryStatus",
    "conversationStatus",
    "generationStatus",
    "turnCount",
    "createdAt",
    "sentAt",
    "conversationClosedAt",
    "generatedAt",
    "contentPurged",
  ]) {
    assert.match(listItem, new RegExp(`\\b${field}\\??:`));
  }
  assert.doesNotMatch(
    listItem,
    /\b(?:messages|transcript|analysis|providerCalls|responseContent)\b/,
    "session list items must never expose raw content",
  );

  assert.match(
    types,
    /export type AdminSessionAnalysis\s*=\s*[\s\S]*kind:\s*"model"\s*\|\s*"fallback"[\s\S]*version:\s*1[\s\S]*summary:\s*string[\s\S]*improvementPoints:\s*string\[\][\s\S]*overallScore:\s*number[\s\S]*kind:\s*"legacy";\s*raw:\s*string/,
  );
  for (const field of [
    "contentPurgedAt",
    "aiTracePurgedAt",
    "delivery",
    "messages",
    "response",
    "reportDeliveries",
    "providerCalls",
  ]) {
    assert.match(types, new RegExp(`\\b${field}\\??:`));
  }
  assert.match(
    api,
    /getSessions:[\s\S]*filters:\s*AdminSessionsFilters\s*=\s*\{\}[\s\S]*params:\s*\{\s*page,\s*limit,\s*userId,\s*topic,\s*source,\s*deliveryStatus,\s*conversationStatus,\s*generationStatus,\s*from,\s*to,/,
  );
  assert.match(api, /getSessionById:[\s\S]*apiClient\.get<AdminSessionDetail>\(\s*`\/admin\/sessions\/\$\{id\}`/);
  assert.match(router, /path:\s*"sessions"[^\n]*name:\s*"sessions"[^\n]*SessionsPage\.vue/);
  assert.match(router, /path:\s*"sessions\/:id"[^\n]*name:\s*"session-detail"[^\n]*SessionDetailPage\.vue/);
  assert.doesNotMatch(router, /path:\s*"sessions(?:"|\/:id")[^\n]*meta:\s*\{\s*public:\s*true/);
  assert.match(navigation, /path:\s*"\/sessions"[^\n]*label:\s*"Сессии"/);
  assert.match(userDetail, /router\.push\(\{\s*path:\s*'\/sessions',\s*query:\s*\{\s*userId:\s*id\s*\}/);
});

test("session pages preserve filtering, disclosure, copy, and purge states", () => {
  const list = read("src/pages/SessionsPage.vue");
  const detail = read("src/pages/SessionDetailPage.vue");

  assert.match(list, /typeof route\.query\.userId\s*===\s*"string"/);
  assert.match(list, /<form\b[^>]*@submit\.prevent="applyFilters"[^>]*@reset\.prevent="resetFilters"/);
  assert.match(list, /<FieldGroup\b[\s\S]*<Field\b/);
  assert.match(list, /<SelectContent>[\s\S]*<SelectGroup>[\s\S]*<SelectItem\b/);
  for (const filter of [
    "userId",
    "topic",
    "source",
    "deliveryStatus",
    "conversationStatus",
    "generationStatus",
    "from",
    "to",
  ]) {
    assert.match(list, new RegExp(`\\b${filter}:`));
  }
  assert.match(list, /let requestSequence\s*=\s*0/);
  assert.match(list, /const requestId\s*=\s*\+\+requestSequence/);
  assert.match(list, /<Skeleton\b/);
  assert.match(list, /<StatePanel\b[\s\S]*@retry=/);
  assert.match(list, /<Empty\b/);
  assert.match(list, /<Pagination\b/);
  assert.match(list, /watch\([\s\S]*route\.query\.userId[\s\S]*filters\.userId\s*=\s*userId[\s\S]*load\(1\)/);

  assert.match(detail, /const sensitiveRevealed\s*=\s*ref\(false\)/);
  assert.match(detail, /Показать чувствительное содержимое/);
  assert.match(detail, /sensitiveRevealed\s*=\s*!sensitiveRevealed/);
  assert.match(detail, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(detail, /!sensitiveRevealed[\s\S]*message\.content !== null/);
  assert.match(detail, /!sensitiveRevealed[\s\S]*session\.response\.transcript !== null/);
  assert.match(detail, /!sensitiveRevealed[\s\S]*session\.response\.analysis/);
  assert.match(detail, /!sensitiveRevealed[\s\S]*call\.responseContent !== null/);
  assert.match(detail, /analysis\.kind === "legacy"[\s\S]*analysis\.raw[\s\S]*JSON\.stringify\(analysis,\s*null,\s*2\)/);
  assert.match(detail, /session\.contentPurged/);
  assert.match(detail, /session\.contentPurgedAt/);
  assert.match(detail, /session\.aiTracePurgedAt/);
  assert.match(detail, /sensitiveRevealed\s*&&\s*message\.voiceFileId/);
  assert.match(detail, /path:\s*'\/error-logs'[\s\S]*correlationId:\s*call\.correlationId/);
  assert.match(detail, /call\.outcome === "empty"[\s\S]*call\.outcome === "failed"[\s\S]*return "Недоступно"/);
  assert.doesNotMatch(detail, /providerContentLabel[\s\S]{0,400}aiTracePurgedAt/);
  assert.match(detail, /sensitiveDataPurgedAt/);
  assert.match(detail, /session\.messages/);
  assert.match(detail, /session\.reportDeliveries/);
  assert.match(detail, /session\.providerCalls/);
});

test("user-detail SPA contract exposes aggregates and routes detailed history through sessions", () => {
  const types = read("src/types/index.ts");
  const page = read("src/pages/UserDetailPage.vue");
  const userDetail = types.match(/export interface UserDetail\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(userDetail, "UserDetail interface must remain declared");
  assert.match(userDetail, /\blanguageLevel:\s*string\s*\|\s*null/);
  assert.match(userDetail, /\bstatus:\s*string/);
  assert.match(userDetail, /\bbannedAt:\s*string\s*\|\s*null/);
  assert.match(userDetail, /\bbannedReason:\s*string\s*\|\s*null/);
  assert.match(userDetail, /\bresponsesCount:\s*number/);
  assert.match(userDetail, /\baverageScore:\s*number\s*\|\s*null/);
  assert.doesNotMatch(userDetail, /\bresponses\??:/);
  assert.doesNotMatch(types, /export interface UserResponse\b/);
  assert.match(page, /router\.push\(\{\s*path:\s*'\/sessions',\s*query:\s*\{\s*userId:\s*id\s*\}/);
  assert.doesNotMatch(page, /user\.responses\b|row\.transcript|paginatedResponses|responsePage/);
  assert.match(
    page,
    /async function changeLevel\(level:unknown\)\{const\s+\w+\s*=\s*typeof level==="string"&&level!=="__none"\?level:null;\s*if\s*\(\s*!user\.value\s*\|\|\s*(?:\w+===user\.value\.languageLevel|user\.value\.languageLevel===\w+)\s*\)\s*return;\s*await update/,
    "unchanged normalized language levels must not issue a PATCH request",
  );
});

test("authentication preserves token, Bearer, and 401 contracts", () => {
  const client = read("src/api/client.ts");
  const authApi = read("src/api/auth.api.ts");
  const auth = read("src/composables/useAuth.ts");

  assert.match(client, /baseURL:\s*API_BASE_URL/);
  assert.match(client, /const API_BASE_URL\s*=\s*"\/api"/);
  assert.match(client, /localStorage\.getItem\("token"\)/);
  assert.match(client, /config\.headers\.Authorization\s*=\s*`Bearer \$\{token\}`/);
  assert.match(client, /error\.response\?\.status\s*===\s*401/);
  assert.match(client, /localStorage\.removeItem\("token"\)[\s\S]*window\.location\.href\s*=\s*"\/login"/);
  assert.match(client, /return Promise\.reject\(error\)/);

  assert.match(authApi, /apiClient\.post<LoginResponse>\("\/auth\/login"/);
  assert.match(authApi, /apiClient\.get<AdminUser>\("\/auth\/me"\)/);
  assert.match(auth, /localStorage\.setItem\("token",\s*response\.accessToken\)/);
  assert.match(auth, /function logout\(\)[\s\S]*localStorage\.removeItem\("token"\)[\s\S]*state\.user\s*=\s*null/);
  assert.match(auth, /if\s*\(!token\)[\s\S]*initialized:\s*true[\s\S]*return/);
  assert.match(auth, /state\.user\s*=\s*await authApi\.me\(\)/);
});

test("shadcn-vue and Tailwind replace Element Plus, React, and Ant Design", () => {
  const packageJson = JSON.parse(read("package.json"));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const dependency of [
    "vue",
    "vue-router",
    "shadcn-vue",
    "reka-ui",
    "vue-sonner",
    "@lucide/vue",
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
    "tailwindcss",
    "@tailwindcss/vite",
  ]) {
    assert.ok(dependencies[dependency], `${dependency} dependency is required`);
  }

  for (const dependency of [
    "element-plus",
    "react",
    "react-dom",
    "react-router-dom",
    "antd",
    "@ant-design/icons",
  ]) {
    assert.equal(dependencies[dependency], undefined, `${dependency} must not remain installed`);
  }

  const forbidden = /(?:from\s*|import\s*)["'](?:element-plus|react|react-dom|react-router-dom|antd|@ant-design\/)|\b(?:ElementPlus|ElMessage|ElMessageBox|ReactDOM)\b|<\/?el-/i;
  for (const file of sourceFiles("src")) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      forbidden,
      `${relative(adminRoot, file)} still references a replaced UI stack`,
    );
  }
});

test("destructive page actions use accessible AlertDialogs", () => {
  for (const path of [
    "src/pages/PromptsPage.vue",
    "src/pages/ErrorLogsPage.vue",
    "src/pages/UserDetailPage.vue",
  ]) {
    const source = read(path);
    assert.match(source, /<AlertDialog\b[\s\S]*<AlertDialogContent\b[\s\S]*<AlertDialogTitle\b[\s\S]*<AlertDialogDescription\b/);
    assert.doesNotMatch(source, /\bElMessageBox\b|\bwindow\.confirm\s*\(/);
  }
});

test("collection pages preserve loading, error, empty, and retry states", () => {
  for (const path of [
    "src/pages/UsersPage.vue",
    "src/pages/PromptsPage.vue",
    "src/pages/TopicsPage.vue",
    "src/pages/ErrorLogsPage.vue",
    "src/pages/AuditLogsPage.vue",
    "src/pages/SessionsPage.vue",
  ]) {
    const source = read(path);
    assert.match(source, /<Skeleton\b/, `${path} must preserve a loading state`);
    assert.match(source, /<StatePanel\b[\s\S]*@retry=/, `${path} must preserve a retryable error state`);
    assert.match(source, /<Empty\b/, `${path} must preserve an empty state`);
  }

  const statePanel = read("src/components/StatePanel.vue");
  assert.match(statePanel, /<Empty\b[^>]*role="status"/);
  assert.match(statePanel, /\$emit\("retry"\)/);
});

test("pagination renders ellipses without replacing mobile previous and next content", () => {
  for (const path of [
    "src/pages/UsersPage.vue",
    "src/pages/PromptsPage.vue",
    "src/pages/ErrorLogsPage.vue",
    "src/pages/AuditLogsPage.vue",
    "src/pages/SessionsPage.vue",
  ]) {
    const source = read(path);
    assert.match(
      source,
      /import\s*\{[^}]*\bPaginationEllipsis\b[^}]*\}\s*from\s*"@\/components\/ui\/pagination"/,
      path + " must import PaginationEllipsis",
    );
    assert.match(
      source,
      /<PaginationEllipsis\b/,
      path + " must render ellipsis items",
    );
    assert.doesNotMatch(
      source,
      /<Pagination(?:Previous|Next)\b[^>]*>\s*<span\b[^>]*\bhidden\b/,
      path + " must not replace pagination navigation with a hidden-only label",
    );
  }
});

test("mobile navigation closes from a sidebar descendant", () => {
  const applicationComponents = sourceFiles("src/components")
    .filter((path) => !path.includes(join("components", "ui")))
    .map((path) => readFileSync(path, "utf8"));

  assert.ok(
    applicationComponents.some(
      (source) => /\buseSidebar\s*\(\s*\)/.test(source)
        && /setOpenMobile\s*\(\s*false\s*\)/.test(source),
    ),
    "a component rendered below SidebarProvider must close mobile navigation",
  );
});

test("users, prompts, audit logs, and sessions ignore stale list requests", () => {
  for (const [path, collection] of [
    ["src/pages/UsersPage.vue", "users"],
    ["src/pages/PromptsPage.vue", "prompts"],
    ["src/pages/AuditLogsPage.vue", "logs"],
    ["src/pages/SessionsPage.vue", "sessions"],
  ]) {
    const source = read(path);
    assert.match(source, /let\s+requestSequence\s*=\s*0/);
    assert.match(source, /const\s+requestId\s*=\s*\+\+requestSequence/);
    assert.match(
      source,
      new RegExp("if\\s*\\(\\s*requestId\\s*!==\\s*requestSequence\\s*\\)\\s*return[\\s\\S]*" + collection + "\\.value\\s*="),
      path + " must reject stale results before updating data",
    );
    assert.match(source, /catch\s*\{\s*if\s*\(\s*requestId\s*===\s*requestSequence\s*\)/);
    assert.match(source, /finally\s*\{\s*if\s*\(\s*requestId\s*===\s*requestSequence\s*\)/);
  }
});

test("pending error-log clearing cannot close its confirmation", () => {
  const source = read("src/pages/ErrorLogsPage.vue");
  const alertDialog = source.match(/<AlertDialog\b[\s\S]*?(?=<AlertDialogContent\b)/)?.[0];

  assert.ok(alertDialog, "the clear confirmation must use controlled open state");
  assert.match(alertDialog, /@update:open="[^"]*!clearing[^"]*"/);
  assert.match(source, /<AlertDialogCancel\b[^>]*:disabled="clearing"/);
  assert.match(source, /<AlertDialogAction\b[^>]*:disabled="clearing"/);
  assert.match(source, /clearOpen\.value\s*=\s*false/);
});

test("admin styles do not depend on Google Fonts", () => {
  assert.doesNotMatch(read("src/styles.css"), /fonts\.googleapis\.com/i);
});

test("admin defaults to the official dark emerald theme", () => {
  const html = read("index.html");
  const htmlRoot = html.match(/<html\b[^>]*>/i)?.[0];
  const rootClasses = htmlRoot
    ?.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]
    .split(/\s+/);

  assert.ok(rootClasses?.includes("dark"), "the root html element must enable dark mode");

  const styles = read("src/styles.css");
  const darkRule = styles.match(/(?:^|\n)\s*\.dark\s*\{([^}]*)\}/)?.[1];
  assert.ok(darkRule, "styles.css must define a .dark theme rule");

  const declarations = Object.fromEntries(
    [...darkRule.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+)\s*;/g)]
      .map(([, property, value]) => [property, value.trim()]),
  );

  assert.deepEqual(
    {
      "color-scheme": declarations["color-scheme"],
      "--primary": declarations["--primary"],
      "--primary-foreground": declarations["--primary-foreground"],
      "--sidebar-primary": declarations["--sidebar-primary"],
      "--sidebar-primary-foreground": declarations["--sidebar-primary-foreground"],
      "--chart-1": declarations["--chart-1"],
      "--chart-2": declarations["--chart-2"],
      "--chart-3": declarations["--chart-3"],
      "--chart-4": declarations["--chart-4"],
      "--chart-5": declarations["--chart-5"],
    },
    {
      "color-scheme": "dark",
      "--primary": "oklch(0.696 0.17 162.48)",
      "--primary-foreground": "oklch(0.205 0 0)",
      "--sidebar-primary": "oklch(0.696 0.17 162.48)",
      "--sidebar-primary-foreground": "oklch(0.205 0 0)",
      "--chart-1": "var(--color-emerald-300)",
      "--chart-2": "var(--color-emerald-500)",
      "--chart-3": "var(--color-emerald-600)",
      "--chart-4": "var(--color-emerald-700)",
      "--chart-5": "var(--color-emerald-800)",
    },
  );

  assert.match(
    styles,
    /\.code-block\s*\{[^}]*bg-muted[^}]*text-foreground[^}]*\}/,
    "code blocks must stay dark instead of inverting to a light surface",
  );
});

test("components.json keeps the official shadcn-vue Tailwind and alias contract", () => {
  const components = JSON.parse(read("components.json"));

  assert.equal(components.$schema, "https://shadcn-vue.com/schema.json");
  assert.match(components.style, /^reka-/);
  assert.equal(components.typescript, true);
  assert.deepEqual(components.tailwind, {
    config: "",
    css: "src/styles.css",
    baseColor: "neutral",
    cssVariables: true,
    prefix: "",
  });
  assert.equal(components.iconLibrary, "lucide");
  assert.deepEqual(components.aliases, {
    components: "@/components",
    utils: "@/lib/utils",
    ui: "@/components/ui",
    lib: "@/lib",
    composables: "@/composables",
  });
  assert.deepEqual(components.registries, {});
});

test("Vue entry point and Tailwind-enabled Vite build remain deployable", () => {
  const packageJson = JSON.parse(read("package.json"));
  const entry = read("src/main.ts");
  const app = read("src/App.vue");
  const html = read("index.html");
  const vite = read("vite.config.ts");
  const dockerfile = read("Dockerfile");
  const nginx = read("default.conf.template");

  assert.equal(packageJson.scripts.build, "vue-tsc --noEmit && vite build");
  assert.match(entry, /import\s*\{\s*createApp\s*\}\s*from\s*"vue"/);
  assert.match(entry, /createApp\(App\)\.use\(router\)\.mount\("#app"\)/);
  assert.match(app, /import\s*\{\s*Toaster\s*\}\s*from\s*"@\/components\/ui\/sonner"/);
  assert.match(app, /<Toaster\b/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /<script type="module" src="\/src\/main\.ts"><\/script>/);
  assert.match(vite, /import\s+tailwindcss\s+from\s+"@tailwindcss\/vite"/);
  assert.match(vite, /plugins:\s*\[vue\(\),\s*tailwindcss\(\)\]/);
  assert.match(vite, /alias:\s*\{\s*"@":\s*path\.resolve\(__dirname,\s*"\.\/src"\)/);
  assert.match(vite, /"\/api"[\s\S]*target:\s*"http:\/\/localhost:3000"[\s\S]*replace\(\/\^\\\/api\/,\s*""\)/);

  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run build/);
  const runtimeStageMarker = dockerfile.search(/^FROM .* AS runtime$/m);
  assert.notEqual(runtimeStageMarker, -1, "Dockerfile must keep a separate runtime stage");
  const buildStage = dockerfile.slice(0, runtimeStageMarker);
  const runtimeStage = dockerfile.slice(runtimeStageMarker);
  const nodeOptions = "ENV NODE_OPTIONS=--max-old-space-size=1024";
  assert.equal(
    buildStage.match(/^ENV NODE_OPTIONS=--max-old-space-size=1024$/gm)?.length,
    1,
    "the build stage must set the exact Node heap limit once",
  );
  assert.ok(
    buildStage.indexOf(nodeOptions) < buildStage.indexOf("RUN npm run build"),
    "the Node heap limit must be configured before the admin build",
  );
  assert.doesNotMatch(
    runtimeStage,
    /NODE_OPTIONS/,
    "the nginx runtime stage must not carry the build-only Node option",
  );
  assert.match(dockerfile, /COPY --from=build[\s\S]*\/usr\/src\/admin\/dist[\s\S]*\/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /USER nginx/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(nginx, /location \/api\/\s*\{[\s\S]*proxy_pass http:\/\/app:\$\{PORT\}\//);
  assert.match(nginx, /location \/\s*\{[\s\S]*try_files \$uri \$uri\/ \/index\.html/);
});

test("runtime settings SPA preserves allowlisted editing and secret-safe states", () => {
  const api = read("src/api/admin.api.ts");
  const types = read("src/types/index.ts");
  const router = read("src/router/index.ts");
  const navigation = read("src/components/adminNavigation.ts");
  const page = read("src/pages/SettingsPage.vue");

  assert.match(router, /path:\s*"settings"[^\n]*name:\s*"settings"[^\n]*SettingsPage\.vue/);
  assert.doesNotMatch(router, /path:\s*"settings"[^\n]*meta:\s*\{\s*public:\s*true/);
  assert.match(navigation, /path:\s*"\/settings"[^\n]*label:\s*"Настройки"/);
  assert.match(api, /getRuntimeSettings:[\s\S]*apiClient\.get<AdminRuntimeSettings>\("\/admin\/settings"\)/);
  assert.match(api, /updateProductSettings:[\s\S]*apiClient\.patch<AdminRuntimeSettingsGroup>\("\/admin\/settings\/product",\s*data\)/);
  assert.match(api, /updateInfrastructureSettings:[\s\S]*apiClient\.patch<AdminRuntimeSettingsGroup>\("\/admin\/settings\/infrastructure",\s*data\)/);

  assert.match(types, /export interface AdminRuntimeSettings\s*\{[\s\S]*product:\s*AdminRuntimeSettingsGroup[\s\S]*infrastructure:\s*AdminRuntimeSettingsGroup[\s\S]*readonly:\s*AdminRuntimeReadonlyEntry\[\][\s\S]*secret:\s*AdminRuntimeSecretEntry\[\]/);
  const secret = types.match(/export interface AdminRuntimeSecretEntry\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(secret);
  assert.match(secret, /key:\s*string[\s\S]*description:\s*string[\s\S]*configured:\s*boolean/);
  assert.doesNotMatch(secret, /(?:value|envValue|overrideValue|effectiveValue|pendingValue):/);
  const secretTitle = page.indexOf("Секреты</CardTitle>");
  const secretCard = page.slice(page.lastIndexOf("<Card>", secretTitle), page.indexOf("</Card>", secretTitle));
  assert.ok(secretTitle >= 0, "settings must render a dedicated secrets section");
  assert.match(secretCard, /entry\.configured/);
  assert.doesNotMatch(secretCard, /entry\.(?:value|envValue|overrideValue|effectiveValue|pendingValue)/);

  assert.match(page, /adminApi\.getRuntimeSettings\(\)/);
  assert.match(page, /expectedVersion:\s*settings\.value\[group\]\.version/);
  assert.match(page, /function resetEntry\([\s\S]*drafts\[group\]\[key\]\s*=\s*""/);
  assert.match(page, /function parseEntry\([\s\S]*if\s*\(!value\)\s*return null/);
  assert.match(page, /values\[entry\.key\]\s*=\s*parseEntry\(entry,\s*drafts\[group\]\[entry\.key\]/);
  assert.match(page, /error\.response\?\.status\s*===\s*409[\s\S]*await load\(\{ group, draft: attemptedDraft \}\)[\s\S]*conflict\.value\s*=\s*group/);
  assert.match(page, /conflict === 'product'[\s\S]*Применить[^<]*ещё раз/);
  assert.match(page, /conflict === 'infrastructure'[\s\S]*подтвердите[^<]*повторно/);
  assert.match(page, /error\.response\?\.status\s*===\s*422/);
  assert.match(page, /error\.response\?\.status\s*===\s*503/);
  assert.match(page, /<AlertDialog[\s\S]*перезапуск[\s\S]*saveGroup\('infrastructure'\)/);
  assert.match(page, /function requestInfrastructureSave\(\)[\s\S]*Object\.keys\(values\)\.length[\s\S]*infrastructureConfirmationOpen\.value\s*=\s*true/);
  assert.match(page, /:disabled="loading \|\| saving !== null"\s+@click="load\(\)"/);
  assert.match(page, /<Input[^>]*:disabled="saving !== null"/);
  assert.match(page, /<AlertDialogCancel[^>]*:disabled="saving !== null"/);
  assert.match(page, /<AlertDialogAction[^>]*:disabled="saving !== null"[^>]*saveGroup\('infrastructure'\)/);
  assert.match(page, /<StatePanel[\s\S]*@retry=/);
  assert.match(page, /<Skeleton\b/);
  assert.match(page, /settings\.infrastructure\.restartRequired/);
  assert.match(page, /settings\.secret/);
});
