const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const packageJsonPath = path.resolve(__dirname, "..", "package.json");

async function readScripts() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return packageJson.scripts;
}

test("docker script defines the local Compose project and remains a raw passthrough", async () => {
  const scripts = await readScripts();

  assert.equal(
    scripts.docker,
    "docker compose -f docker-compose.yml -f compose.tailscale.yml",
  );
});

test("Docker helper scripts delegate the expected arguments to the base script", async () => {
  const scripts = await readScripts();
  const expected = {
    "docker:config": "npm run docker -- config --quiet",
    "docker:build": "npm run docker -- build",
    "docker:up": "npm run docker -- up -d --build",
    "docker:recreate": "npm run docker -- up -d --build --force-recreate",
    "docker:down": "npm run docker -- down --remove-orphans",
    "docker:logs": "npm run docker -- logs --follow --tail=200",
    "docker:ps": "npm run docker -- ps",
    "docker:init": "npm run docker -- run --rm --build init node dist-seed/seed.js",
  };

  for (const [name, command] of Object.entries(expected)) {
    assert.equal(scripts[name], command, `${name} must keep its documented contract`);
  }
});

test("local Docker helpers stay non-destructive, portable, and local-only", async () => {
  const scripts = await readScripts();
  const helperNames = [
    "docker:config",
    "docker:build",
    "docker:up",
    "docker:recreate",
    "docker:down",
    "docker:logs",
    "docker:ps",
    "docker:init",
  ];

  for (const name of helperNames) {
    const command = scripts[name];

    assert.match(command, /^npm run docker --(?: |$)/, `${name} must use the base script`);
    assert.doesNotMatch(
      command,
      /(?:^|\s)(?:[^\s]*prod(?:uction)?[^\s]*\.ya?ml|--env-file(?:=|\s+)[^\s]*prod)/i,
      `${name} must not reference production Compose configuration`,
    );
    assert.doesNotMatch(
      command,
      /(?:&&|\|\||;|\||\$\(|`|(?:^|\s)(?:export|set)\s|(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=)/,
      `${name} must not depend on shell-specific chaining or environment assignment`,
    );
  }

  assert.doesNotMatch(
    scripts["docker:down"],
    /(?:^|\s)(?:-v|--volumes)(?:\s|$)/,
    "docker:down must preserve named volumes by default",
  );

  assert.match(
    scripts["docker:init"],
    /\binit node dist-seed\/seed\.js$/,
    "docker:init must override the init service CMD with the built seed artifact",
  );
  assert.doesNotMatch(
    scripts["docker:init"],
    /(?:deploy:init|prisma(?::migrate|\s+migrate)|migrate(?:\s|$))/,
    "docker:init must seed without running migrations again",
  );
});

test("operations gate includes backend, Admin SPA, PostgreSQL and both production images", async () => {
  const scripts = await readScripts();

  assert.equal(
    scripts["test:admin"],
    "npm --prefix admin test && npm --prefix admin run build",
  );
  assert.equal(
    scripts["test:admin-container"],
    "node scripts/verify-admin-image.js",
  );
  assert.equal(
    scripts["test:container"],
    "node scripts/verify-runtime-image.js && node scripts/verify-admin-image.js",
  );
  assert.equal(
    scripts["test:operations"],
    "npm run build && npm run test:admin && node --test test/user-journey.test.js && node scripts/run-postgres-integration.js && npm run test:container",
  );

  const verifier = await readFile(
    path.resolve(__dirname, "..", "scripts", "verify-admin-image.js"),
    "utf8",
  );
  assert.match(verifier, /--target", "runtime"/);
  assert.match(verifier, /talking-bob\.admin-image-check/);
  assert.match(verifier, /ownedContainerExists/);
  assert.match(verifier, /ownedImageExists/);
  assert.match(verifier, /refusing to manage an unowned container/);
  assert.match(verifier, /refusing to manage an unowned image/);
  assert.match(verifier, /docker\(\["rm", "--force", containerName\]/);
  assert.match(verifier, /docker\(\["image", "rm", tag\]/);
  assert.match(verifier, /127\.0\.0\.1:8080\/healthz/);
  assert.match(verifier, /identity\.stdout\.trim\(\), "0"/);
  assert.match(verifier, /127\.0\.0\.1:8080\/broadcasts\/new/);
  assert.match(verifier, /deepLink\.stdout, root\.stdout/);
  assert.match(verifier, /network", "create"/);
  assert.match(verifier, /owned-upstream/);
  assert.match(verifier, /127\.0\.0\.1:8080\/api\/rollout-probe/);
  assert.match(verifier, /JSON\.parse\(proxied\.stdout\)/);
  assert.match(verifier, /network", "rm", networkName/);
});
