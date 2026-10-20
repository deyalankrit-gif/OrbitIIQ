"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createServer } = require("./server");
const { openDatabase } = require("./database");

let appServer;
let providerServer;
let appBase;
let providerBase;
let originalEnv;
let testDatabaseDirectory;
let authCookie = "";
const providerRequests = [];
const providerRequestUrls = [];
const providerApiKeyHeaders = [];
const verificationCodes = new Map();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function appFetch(route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (authCookie && !headers.has("cookie")) headers.set("cookie", authCookie);
  if (appBase && !headers.has("origin") && options.method && options.method !== "GET") headers.set("origin", appBase);
  return fetch(`${appBase}${route}`, { ...options, headers });
}

async function createTestAccount(email, profile = {
  role: "School student", name: "Test learner", age: 16, institution: "Test School", level: "Class 10"
}) {
  const requestResponse = await fetch(`${appBase}/api/auth/request-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase },
    body: JSON.stringify({ email, mode: "signup", profile })
  });
  assert.equal(requestResponse.status, 200);
  const browserCookie = requestResponse.headers.get("set-cookie").split(";")[0];
  const code = verificationCodes.get(email);
  assert.match(code, /^\d{6}$/);
  const verifyResponse = await fetch(`${appBase}/api/auth/verify-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase, cookie: browserCookie },
    body: JSON.stringify({ email, code })
  });
  assert.equal(verifyResponse.status, 200);
  const sessionCookie = verifyResponse.headers.get("set-cookie").split(";")[0];
  return `${browserCookie}; ${sessionCookie}`;
}

before(async () => {
  originalEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    DATABASE_PATH: process.env.DATABASE_PATH,
    TRUST_PROXY: process.env.TRUST_PROXY
  };
  testDatabaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "OrbitIQ-test-"));
  process.env.DATABASE_PATH = path.join(testDatabaseDirectory, "test.sqlite");
  providerServer = http.createServer(async (request, response) => {
    providerRequestUrls.push(request.url);
    providerApiKeyHeaders.push(request.headers["x-goog-api-key"]);
    const body = JSON.parse(await readRequest(request));
    providerRequests.push(body);
    if (JSON.stringify(body).includes("quota-test-marker")) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { message: "Your quota has been exceeded.", code: "insufficient_quota", type: "insufficient_quota" }
      }));
      return;
    }
    const properties = body.generationConfig?.responseSchema?.properties || {};
    const output = properties.cards
      ? { cards: [
          { question: "What is a test question?", answer: "A test answer." },
          { question: "What is another question?", answer: "Another answer." },
          { question: "What is the last question?", answer: "The last answer." }
        ] }
      : properties.questions
        ? { questions: Array.from({ length: 5 }, (_, index) => ({
            q: `Question ${index + 1}?`,
            choices: ["A", "B", "C", "D"],
            answer: 2,
            explain: "Because this is a test."
          })) }
        : properties.facts
          ? { facts: Array.from({ length: 3 }, (_, index) => ({
              fact: `Fact ${index + 1}.`,
              explanation: `Explanation ${index + 1}.`
            })) }
          : null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: output ? JSON.stringify(output) : "A clear explanation from the mock AI provider." }] } }]
    }));
  });
  const providerPort = await listen(providerServer);
  providerBase = `http://127.0.0.1:${providerPort}/v1beta`;
  process.env.GEMINI_API_KEY = "test-only-key";
  process.env.GEMINI_BASE_URL = providerBase;
  process.env.GEMINI_MODEL = "test-model";
  appServer = createServer({
    sendVerificationCode: async ({ email, code }) => verificationCodes.set(email, code)
  });
  const appPort = await listen(appServer);
  appBase = `http://127.0.0.1:${appPort}`;
  authCookie = await createTestAccount("main-test@example.test");
});

after(async () => {
  await close(appServer);
  await close(providerServer);
  fs.rmSync(testDatabaseDirectory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("account study data is stored persistently and isolated by authenticated user", async () => {
  const initialResponse = await appFetch("/api/data");
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).state.data, undefined);
  const profile = { role: "School student", name: "Test learner", age: 16, institution: "Test School", level: "Class 10" };
  const data = { subject: "Physics", schedules: { timetable: [] }, exams: [] };

  const saveResponse = await appFetch("/api/data", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, data })
  });
  assert.equal(saveResponse.status, 200);

  const restoredResponse = await appFetch("/api/data");
  const restored = await restoredResponse.json();
  assert.deepEqual(restored.state.profile, profile);
  assert.deepEqual(restored.state.data, data);
  assert.ok(restored.state.updatedAt);
  const database = await openDatabase(process.env.DATABASE_PATH);
  try {
    assert.deepEqual(database.getUserState(database.getUserByEmail("main-test@example.test").id).data, data);
  } finally {
    database.close();
  }

  const otherAccountCookie = await createTestAccount("other-test@example.test", {
    role: "Other", name: "Other learner", age: 20, institution: "", level: "Other / lifelong learner"
  });
  const otherAccountResponse = await fetch(`${appBase}/api/data`, { headers: { cookie: otherAccountCookie } });
  assert.equal(otherAccountResponse.status, 200);
  assert.equal((await otherAccountResponse.json()).state.data, undefined);
});

test("account study data rejects cross-origin and invalid writes", async () => {
  const body = JSON.stringify({ profile: null, data: {} });

  const crossOriginResponse = await fetch(`${appBase}/api/data`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://attacker.example", cookie: authCookie },
    body
  });
  assert.equal(crossOriginResponse.status, 403);

  const invalidResponse = await fetch(`${appBase}/api/data`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: appBase, cookie: authCookie },
    body: JSON.stringify({ profile: "not a profile", data: {} })
  });
  assert.equal(invalidResponse.status, 400);
});

test("legacy browser data is claimed once instead of copied to later accounts", async () => {
  const legacyPath = path.join(testDatabaseDirectory, "legacy-claim.sqlite");
  const database = await openDatabase(legacyPath);
  try {
    database.save("browser-id", { name: "Legacy learner" }, { topics: ["Old data"] });
    assert.deepEqual(database.claimBrowserState("browser-id").data, { topics: ["Old data"] });
    assert.equal(database.get("browser-id"), null);
    assert.equal(database.claimBrowserState("browser-id"), null);
  } finally {
    database.close();
  }
});

test("email verification creates accounts and server-managed sessions", async () => {
  const anonymousDataResponse = await fetch(`${appBase}/api/data`);
  assert.equal(anonymousDataResponse.status, 401);
  const anonymousAIResponse = await fetch(`${appBase}/api/learn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "doubt", subject: "Physics", topic: "Gravity", question: "Why?" })
  });
  assert.equal(anonymousAIResponse.status, 401);

  const email = "session-flow@example.test";
  const cookie = await createTestAccount(email);
  const saveResponse = await fetch(`${appBase}/api/data`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: appBase, cookie },
    body: JSON.stringify({
      profile: { role: "School student", name: "Test learner", age: 16, institution: "", level: "Class 10" },
      data: { subject: "Biology", topics: ["Cells"] }
    })
  });
  assert.equal(saveResponse.status, 200);

  const logoutResponse = await fetch(`${appBase}/api/auth/logout`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase, cookie }
  });
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get("set-cookie"), /Max-Age=0/);
  const revokedDataResponse = await fetch(`${appBase}/api/data`, { headers: { cookie } });
  assert.equal(revokedDataResponse.status, 401);

  const requestResponse = await fetch(`${appBase}/api/auth/request-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase },
    body: JSON.stringify({ email, mode: "login" })
  });
  assert.equal(requestResponse.status, 200);
  const browserCookie = requestResponse.headers.get("set-cookie").split(";")[0];
  const loginResponse = await fetch(`${appBase}/api/auth/verify-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: appBase,
      cookie: browserCookie
    },
    body: JSON.stringify({ email, code: verificationCodes.get(email) })
  });
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  const loginResult = await loginResponse.json();
  assert.equal(loginResult.user.email, email);
  assert.deepEqual(loginResult.state.data, { subject: "Biology", topics: ["Cells"] });
});

test("trusted HTTPS proxy requests pass origin checks and set secure cookies", async () => {
  const originalTrustProxy = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "true";
  try {
    const origin = new URL(appBase);
    origin.protocol = "https:";
    const response = await fetch(`${appBase}/api/auth/request-code`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: origin.origin,
        "x-forwarded-proto": "https"
      },
      body: JSON.stringify({
        email: "proxy-test@example.test",
        mode: "signup",
        profile: { role: "Other", name: "Proxy test", age: 16, institution: "", level: "Other / lifelong learner" }
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure(?:;|$)/);
  } finally {
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
  }
});

test("unknown email sign-in does not create an account", async () => {
  const email = "unknown-login@example.test";
  const requestResponse = await fetch(`${appBase}/api/auth/request-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase },
    body: JSON.stringify({ email, mode: "login" })
  });
  assert.equal(requestResponse.status, 200);
  assert.match((await requestResponse.json()).message, /If this email can be used/);
  const cookie = requestResponse.headers.get("set-cookie").split(";")[0];
  const verifyResponse = await fetch(`${appBase}/api/auth/verify-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase, cookie },
    body: JSON.stringify({ email, code: verificationCodes.get(email) })
  });
  assert.equal(verifyResponse.status, 401);
  const database = await openDatabase(process.env.DATABASE_PATH);
  try {
    assert.equal(database.getUserByEmail(email), null);
  } finally {
    database.close();
  }
});

test("email verification codes are single-use and limited to five attempts", async () => {
  const email = "attempt-limit@example.test";
  const requestResponse = await fetch(`${appBase}/api/auth/request-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase },
    body: JSON.stringify({
      email, mode: "signup",
      profile: { role: "Other", name: "Attempt test", age: 22, institution: "", level: "Other / lifelong learner" }
    })
  });
  assert.equal(requestResponse.status, 200);
  const cookie = requestResponse.headers.get("set-cookie").split(";")[0];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${appBase}/api/auth/verify-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appBase, cookie },
      body: JSON.stringify({ email, code: "000000" })
    });
    assert.equal(response.status, 401);
  }
  const lockedResponse = await fetch(`${appBase}/api/auth/verify-code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appBase, cookie },
    body: JSON.stringify({ email, code: verificationCodes.get(email) })
  });
  assert.equal(lockedResponse.status, 401);
});

test("email delivery failures are reported without issuing a usable code", async () => {
  const failureServer = createServer({
    databasePath: path.join(testDatabaseDirectory, "email-failure.sqlite"),
    sendVerificationCode: async () => { throw new Error("simulated SMTP failure"); }
  });
  const failurePort = await listen(failureServer);
  const failureBase = `http://127.0.0.1:${failurePort}`;
  try {
    const response = await fetch(`${failureBase}/api/auth/request-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: failureBase },
      body: JSON.stringify({ email: "mail-failure@example.test", mode: "login" })
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not send the verification email/i);
  } finally {
    await close(failureServer);
  }
});

test("invalid or expired sessions are rejected and cleared", async () => {
  const response = await fetch(`${appBase}/api/auth/me`, {
    headers: { cookie: "OrbitIQ_session=invalid-session-token-value-which-is-long-enough" }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("the OrbitIQ favicon is served as a PNG", async () => {
  const response = await appFetch("/OrbitIQ_Favicon.png");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("health reports whether the backend has a Gemini API key", async () => {
  const response = await appFetch("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true, model: "test-model" });
});

test("learning endpoint returns a tutor explanation", async () => {
  const requestCount = providerRequestUrls.length;
  const response = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "doubt", subject: "Physics", topic: "Gravity", question: "Why do objects fall?" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "A clear explanation from the mock AI provider.");
  assert.equal(providerRequestUrls.length, requestCount + 1);
  assert.equal(providerRequestUrls.at(-1), "/v1beta/models/test-model:generateContent");
  assert.equal(providerApiKeyHeaders.at(-1), "test-only-key");
  assert.equal(providerRequests.at(-1).generationConfig.maxOutputTokens, 2400);
});

test("AI provider quota errors explain the required account action", async () => {
  const response = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "doubt", subject: "Physics", topic: "quota-test-marker", question: "Explain gravity."
    })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Google Gemini.*quota/i);
});

test("learning endpoint validates structured flashcards and five-question quizzes", async () => {
  const cardsResponse = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "flashcards", subject: "Biology", topic: "Cells" })
  });
  assert.equal(cardsResponse.status, 200);
  assert.equal((await cardsResponse.json()).cards.length, 3);
  const quizResponse = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "quiz", subject: "Mathematics", topic: "Fractions" })
  });
  assert.equal(quizResponse.status, 200);
  assert.equal((await quizResponse.json()).questions.length, 5);
  const factsResponse = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "facts", subject: "Astronomy", topic: "Black holes" })
  });
  assert.equal(factsResponse.status, 200);
  assert.equal((await factsResponse.json()).facts.length, 3);
});

test("homework requests use learning-first instructions", async () => {
  const beforeCount = providerRequests.length;
  const response = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "homework", subject: "Mathematics", topic: "Linear equations",
      learnerLevel: "Class 12", assignment: "Solve 2x + 3 = 9.", stuckPoint: "I do not know the first step."
    })
  });
  assert.equal(response.status, 200);
  assert.equal(providerRequests.length, beforeCount + 1);
  const instructions = providerRequests.at(-1).systemInstruction.parts[0].text;
  assert.match(instructions, /Do not provide a complete answer/);
  assert.match(instructions, /selected study level is Class 12/);
  assert.doesNotMatch(JSON.stringify(providerRequests.at(-1)), /Sam Student|15 years old|North School/);
});

test("career counsellor gives exploratory guidance and does not claim live research", async () => {
  const response = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "career", subject: "Computer Science", topic: "Career exploration",
      learnerLevel: "Class 10", question: "What could I explore if I like solving problems?",
      interests: "Mathematics, programming, design"
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "A clear explanation from the mock AI provider.");
  const providerRequest = providerRequests.at(-1);
  const instructions = providerRequest.systemInstruction.parts[0].text;
  assert.match(instructions, /no live web access/);
  assert.match(instructions, /Never guarantee admission, employment, income/);
  assert.match(providerRequest.contents[0].parts[0].text, /Mathematics, programming, design/);

  const missingQuestion = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "career", subject: "Computer Science", topic: "Career exploration" })
  });
  assert.equal(missingQuestion.status, 400);
  assert.match((await missingQuestion.json()).error, /Question is required/);
});

test("analysis forwards image frames and audio to Gemini", async () => {
  const imageForm = new FormData();
  imageForm.append("subject", "Physics");
  imageForm.append("frame", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "frame-1.jpg");
  imageForm.append("frameTimestamps", "5.0s");
  const imageResponse = await appFetch("/api/analyze", { method: "POST", body: imageForm });
  assert.equal(imageResponse.status, 200);
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.inlineData?.mimeType === "image/jpeg"));
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.text?.includes("5.0s")));

  const audioForm = new FormData();
  audioForm.append("subject", "Physics");
  audioForm.append("file", new Blob(["audio bytes"], { type: "audio/mpeg" }), "lesson.mp3");
  const audioResponse = await appFetch("/api/analyze", { method: "POST", body: audioForm });
  assert.equal(audioResponse.status, 200);
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.inlineData?.mimeType === "audio/mpeg"));
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.text?.includes("Listen to the supplied audio")));
});

test("invalid input and missing API configuration return explicit errors", async () => {
  const invalidResponse = await appFetch("/api/learn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "unsupported" })
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /Unsupported learning tool/);

  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const response = await appFetch("/api/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "doubt", subject: "Physics", topic: "Gravity", question: "Why?" })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /GEMINI_API_KEY/);
  } finally {
    process.env.GEMINI_API_KEY = originalKey;
  }
});
