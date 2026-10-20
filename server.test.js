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
const providerRequests = [];
const providerRequestUrls = [];
const providerApiKeyHeaders = [];

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

before(async () => {
  originalEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    DATABASE_PATH: process.env.DATABASE_PATH
  };
  testDatabaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "studyorbit-test-"));
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
  appServer = createServer();
  const appPort = await listen(appServer);
  appBase = `http://127.0.0.1:${appPort}`;
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

test("browser study data is stored persistently and isolated by its browser cookie", async () => {
  const initialResponse = await fetch(`${appBase}/api/data`);
  assert.equal(initialResponse.status, 200);
  assert.deepEqual(await initialResponse.json(), { state: null });
  const cookie = initialResponse.headers.get("set-cookie").split(";")[0];
  const profile = { name: "Test learner", age: 16 };
  const data = { subject: "Physics", schedules: { timetable: [] }, exams: [] };

  const saveResponse = await fetch(`${appBase}/api/data`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: appBase,
      cookie
    },
    body: JSON.stringify({ profile, data })
  });
  assert.equal(saveResponse.status, 200);

  const restoredResponse = await fetch(`${appBase}/api/data`, { headers: { cookie } });
  const restored = await restoredResponse.json();
  assert.deepEqual(restored.state.profile, profile);
  assert.deepEqual(restored.state.data, data);
  assert.ok(restored.state.updatedAt);
  const database = await openDatabase(process.env.DATABASE_PATH);
  try {
    assert.deepEqual(database.get(cookie.split("=")[1]).data, data);
  } finally {
    database.close();
  }

  const otherBrowserResponse = await fetch(`${appBase}/api/data`);
  assert.deepEqual(await otherBrowserResponse.json(), { state: null });
});

test("browser study data rejects cross-origin and invalid writes", async () => {
  const initialResponse = await fetch(`${appBase}/api/data`);
  const cookie = initialResponse.headers.get("set-cookie").split(";")[0];
  const body = JSON.stringify({ profile: null, data: {} });

  const crossOriginResponse = await fetch(`${appBase}/api/data`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://attacker.example", cookie },
    body
  });
  assert.equal(crossOriginResponse.status, 403);

  const invalidResponse = await fetch(`${appBase}/api/data`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: appBase, cookie },
    body: JSON.stringify({ profile: "not a profile", data: {} })
  });
  assert.equal(invalidResponse.status, 400);
});

test("the StudyOrbit favicon is served as a PNG", async () => {
  const response = await fetch(`${appBase}/StudyOrbit_Favicon.png`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("health reports whether the backend has a Gemini API key", async () => {
  const response = await fetch(`${appBase}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true, model: "test-model" });
});

test("learning endpoint returns a tutor explanation", async () => {
  const requestCount = providerRequestUrls.length;
  const response = await fetch(`${appBase}/api/learn`, {
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
  const response = await fetch(`${appBase}/api/learn`, {
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
  const cardsResponse = await fetch(`${appBase}/api/learn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "flashcards", subject: "Biology", topic: "Cells" })
  });
  assert.equal(cardsResponse.status, 200);
  assert.equal((await cardsResponse.json()).cards.length, 3);
  const quizResponse = await fetch(`${appBase}/api/learn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "quiz", subject: "Mathematics", topic: "Fractions" })
  });
  assert.equal(quizResponse.status, 200);
  assert.equal((await quizResponse.json()).questions.length, 5);
  const factsResponse = await fetch(`${appBase}/api/learn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "facts", subject: "Astronomy", topic: "Black holes" })
  });
  assert.equal(factsResponse.status, 200);
  assert.equal((await factsResponse.json()).facts.length, 3);
});

test("homework requests use learning-first instructions", async () => {
  const beforeCount = providerRequests.length;
  const response = await fetch(`${appBase}/api/learn`, {
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
  const response = await fetch(`${appBase}/api/learn`, {
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

  const missingQuestion = await fetch(`${appBase}/api/learn`, {
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
  const imageResponse = await fetch(`${appBase}/api/analyze`, { method: "POST", body: imageForm });
  assert.equal(imageResponse.status, 200);
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.inlineData?.mimeType === "image/jpeg"));
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.text?.includes("5.0s")));

  const audioForm = new FormData();
  audioForm.append("subject", "Physics");
  audioForm.append("file", new Blob(["audio bytes"], { type: "audio/mpeg" }), "lesson.mp3");
  const audioResponse = await fetch(`${appBase}/api/analyze`, { method: "POST", body: audioForm });
  assert.equal(audioResponse.status, 200);
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.inlineData?.mimeType === "audio/mpeg"));
  assert.ok(providerRequests.at(-1).contents[0].parts.some((part) => part.text?.includes("Listen to the supplied audio")));
});

test("invalid input and missing API configuration return explicit errors", async () => {
  const invalidResponse = await fetch(`${appBase}/api/learn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "unsupported" })
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /Unsupported learning tool/);

  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const response = await fetch(`${appBase}/api/learn`, {
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
