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

test("Vue 3 and Element Plus replace React and Ant Design completely", () => {
  const packageJson = JSON.parse(read("package.json"));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  assert.ok(dependencies.vue, "Vue dependency is required");
  assert.ok(dependencies["vue-router"], "Vue Router dependency is required");
  assert.ok(dependencies["element-plus"], "Element Plus dependency is required");
  for (const dependency of ["react", "react-dom", "react-router-dom", "antd", "@ant-design/icons"]) {
    assert.equal(dependencies[dependency], undefined, `${dependency} must not remain installed`);
  }

  const forbidden = /(?:from\s*|import\s*)["'](?:react|react-dom|react-router-dom|antd|@ant-design\/)|\bReactDOM\b/i;
  for (const file of sourceFiles("src")) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      forbidden,
      `${relative(adminRoot, file)} still references the React\/AntD stack`,
    );
  }
});

test("Vue entry point and Vite build remain deployable", () => {
  const packageJson = JSON.parse(read("package.json"));
  const entry = read("src/main.ts");
  const html = read("index.html");
  const vite = read("vite.config.ts");
  const dockerfile = read("Dockerfile");
  const nginx = read("default.conf.template");

  assert.equal(packageJson.scripts.build, "vue-tsc --noEmit && vite build");
  assert.match(entry, /import\s*\{\s*createApp\s*\}\s*from\s*"vue"/);
  assert.match(entry, /createApp\(App\)\.use\(ElementPlus\)\.use\(router\)\.mount\("#app"\)/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /<script type="module" src="\/src\/main\.ts"><\/script>/);
  assert.match(vite, /plugins:\s*\[vue\(\)\]/);
  assert.match(vite, /"\/api"[\s\S]*target:\s*"http:\/\/localhost:3000"[\s\S]*replace\(\/\^\\\/api\/,\s*""\)/);

  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /COPY --from=build[\s\S]*\/usr\/src\/admin\/dist[\s\S]*\/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /USER nginx/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(nginx, /location \/api\/\s*\{[\s\S]*proxy_pass http:\/\/app:\$\{PORT\}\//);
  assert.match(nginx, /location \/\s*\{[\s\S]*try_files \$uri \$uri\/ \/index\.html/);
});
