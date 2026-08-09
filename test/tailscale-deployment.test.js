const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

function readProjectFile(path) {
  return readFileSync(join(__dirname, "..", path), "utf8");
}

test("Tailscale deployment keeps the admin UI private and production-ready", () => {
  const nginx = readProjectFile("admin/default.conf.template");

  assert.match(
    nginx,
    /location\s+\/\s*\{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/s,
    "nginx must fall back to index.html for SPA routes",
  );
  assert.match(
    nginx,
    /location\s+\/api\/\s*\{[^}]*proxy_pass\s+http:\/\/app:\$\{PORT\}\/\s*;/s,
    "the API proxy must strip /api and use the configured app port",
  );

  for (const overlay of [
    "compose.tailscale.yml",
    "compose.tailscale.production.yml",
  ]) {
    const compose = readProjectFile(overlay);

    assert.match(
      compose,
      /PORT:\s*\$\{PORT:-3000\}/,
      `${overlay} must pass the app port to nginx`,
    );
    assert.match(
      compose,
      /ports:\s*\n\s*-\s*"127\.0\.0\.1:\$\{ADMIN_PORT:-8080\}:8080"/,
      `${overlay} must expose admin only on loopback`,
    );
    assert.doesNotMatch(
      compose,
      /-\s*"(?:0\.0\.0\.0:)?\$\{ADMIN_PORT:-8080\}:8080"/,
      `${overlay} must not expose admin on every interface`,
    );
    assert.match(
      compose,
      /depends_on:\s*\n\s+app:\s*\n\s+condition:\s*service_healthy/,
      `${overlay} must wait for a healthy app service`,
    );
  }

  const dockerfile = readProjectFile("admin/Dockerfile");

  assert.match(dockerfile, /FROM\s+\$\{NODE_IMAGE\}\s+AS\s+build/i);
  assert.match(dockerfile, /RUN\s+npm\s+run\s+build/);
  assert.match(dockerfile, /NGINX_ENVSUBST_FILTER=\^PORT\$/);
  assert.match(
    dockerfile,
    /COPY\s+--from=build(?:\s+--chown=nginx:nginx)?\s+\/usr\/src\/admin\/dist\s+\/usr\/share\/nginx\/html/,
  );
  assert.match(dockerfile, /^USER\s+nginx\s*$/m);
});
