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
  assert.match(source, /clearOldErrorLogs:\s*async\s*\(days:\s*number\s*=\s*30\)/);
  assert.equal((source.match(/params:\s*\{\s*page,\s*limit/g) ?? []).length, 3);
  assert.match(source, /params:\s*\{\s*days\s*\}/);
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
    "src/pages/UserDetailPage.vue",
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

test("users and prompts ignore stale list requests", () => {
  for (const [path, collection] of [
    ["src/pages/UsersPage.vue", "users"],
    ["src/pages/PromptsPage.vue", "prompts"],
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

test("user transcripts remain readable instead of being truncated", () => {
  const source = read("src/pages/UserDetailPage.vue");
  const transcriptCell = source.match(/<TableCell\b([^>]*)>\s*\{\{[^}]*row\.transcript/);

  assert.ok(transcriptCell, "the transcript table cell must remain rendered");
  assert.doesNotMatch(transcriptCell[1], /\btruncate\b/);
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
  assert.match(dockerfile, /COPY --from=build[\s\S]*\/usr\/src\/admin\/dist[\s\S]*\/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /USER nginx/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(nginx, /location \/api\/\s*\{[\s\S]*proxy_pass http:\/\/app:\$\{PORT\}\//);
  assert.match(nginx, /location \/\s*\{[\s\S]*try_files \$uri \$uri\/ \/index\.html/);
});
