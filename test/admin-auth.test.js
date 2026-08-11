const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { AuthService } = require("../dist/modules/auth");

const ADMIN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("auth validates signed admin claim shape before returning the payload", async () => {
  const secret = "admin-auth-contract-secret";
  const auth = new AuthService({}, { jwtSecret: secret });

  const valid = jwt.sign({ sub: ADMIN_ID, username: "  operator  " }, secret);
  assert.deepEqual(await auth.validateToken(valid), { sub: ADMIN_ID, username: "operator" });
  await assert.rejects(
    () => auth.validateToken(jwt.sign({ sub: ADMIN_ID, username: "operator" }, "default-secret-change-me")),
    (error) => error.getStatus() === 401 && error.message === "Invalid token",
  );

  const expired = jwt.sign(
    { sub: ADMIN_ID, username: "operator", exp: Math.floor(Date.now() / 1000) - 1 },
    secret,
  );
  await assert.rejects(
    () => auth.validateToken(expired),
    (error) => error.getStatus() === 401 && error.message === "Invalid token",
  );

  const invalidClaims = [
    { username: "operator" },
    { sub: "admin", username: "operator" },
    { sub: ADMIN_ID },
    { sub: ADMIN_ID, username: "   " },
    { sub: ADMIN_ID, username: "x".repeat(201) },
    { sub: ADMIN_ID, username: "operator\nsecret" },
    { sub: ADMIN_ID, username: ` ${"x".repeat(199)} ` },
  ];
  for (const claims of invalidClaims) {
    const token = jwt.sign(claims, secret);
    await assert.rejects(
      () => auth.validateToken(token),
      (error) => error.getStatus() === 401 && error.message === "Invalid token",
    );
  }
});
