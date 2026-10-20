
"use strict";
 
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual, randomUUID } = require("node:crypto");
const nodemailer = require("nodemailer");
const { openDatabase } = require("./database");
 
const ROOT = __dirname;
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_TEXT_LENGTH = 12_000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const MAX_PROFILE_BYTES = 20 * 1024;
const MAX_STUDY_DATA_BYTES = 4 * 1024 * 1024;
const BROWSER_COOKIE = "OrbitIQ_browser";
const SESSION_COOKIE = "OrbitIQ_session";
const VERIFICATION_CODE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const AUTH_RATE_WINDOW_MS = 15 * 60_000;
const BROWSER_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const rateLimits = new Map();
 
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
 
function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
 
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(payload);
}
 
// CHANGE 1: behind Hostinger's proxy every visitor shares one socket address,
// so rate limits would apply to all users together. With TRUST_PROXY=true we
// use the visitor's real IP from x-forwarded-for instead.
function getClientKey(request) {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || "unknown";
}
 
function checkRateLimit(request) {
  const now = Date.now();
  const key = getClientKey(request);
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(key, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > RATE_LIMIT) throw new ApiError(429, "Too many AI requests. Please wait a minute and try again.");
  }
  if (rateLimits.size > 5000) {
    for (const [client, entry] of rateLimits) {
      if (now - entry.startedAt >= RATE_WINDOW_MS) rateLimits.delete(client);
    }
  }
}
 
async function readBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new ApiError(413, "The request is too large. Reduce the text or upload size and try again.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new ApiError(413, "The request is too large. Reduce the text or upload size and try again.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
 
async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "Send this request as JSON.");
  }
  const body = await readBody(request);
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "The request body must be a JSON object.");
  }
  return parsed;
}
 
async function readFormData(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ApiError(415, "Send uploaded material as multipart form data.");
  }
  const body = await readBody(request);
  try {
    const wrapped = new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
      duplex: "half"
    });
    return await wrapped.formData();
  } catch {
    throw new ApiError(400, "The uploaded form could not be read.");
  }
}
 
function requiredText(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, `${label} is required.`);
  const clean = value.trim();
  if (clean.length > maximum) throw new ApiError(413, `${label} must be ${maximum} characters or fewer.`);
  return clean;
}
 
function optionalText(value, label, maximum = 1000) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new ApiError(400, `${label} must be text.`);
  if (value.length > maximum) throw new ApiError(413, `${label} must be ${maximum} characters or fewer.`);
  return value.trim();
}
 
const schemas = {
  flashcards: {
    type: "object",
    additionalProperties: false,
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { question: { type: "string" }, answer: { type: "string" } },
          required: ["question", "answer"]
        }
      }
    },
    required: ["cards"]
  },
  quiz: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string" },
            choices: { type: "array", items: { type: "string" } },
            answer: { type: "integer" },
            explain: { type: "string" }
          },
          required: ["q", "choices", "answer", "explain"]
        }
      }
    },
    required: ["questions"]
  },
  facts: {
    type: "object",
    additionalProperties: false,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { fact: { type: "string" }, explanation: { type: "string" } },
          required: ["fact", "explanation"]
        }
      }
    },
    required: ["facts"]
  }
};
 
function geminiSchema(schema) {
  if (schema.type === "array") return { type: "ARRAY", items: geminiSchema(schema.items) };
  if (schema.type === "object") {
    return {
      type: "OBJECT",
      properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, geminiSchema(value)])),
      required: schema.required
    };
  }
  return { type: { string: "STRING", integer: "INTEGER" }[schema.type] };
}
 
function responseText(responseData) {
  const text = responseData.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  if (text) return text;
  throw new ApiError(502, "The AI provider returned an empty response. Please try again.");
}
 
function parseStructuredOutput(text, name) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(502, "The AI provider returned an invalid structured response. Please try again.");
  }
  if (name === "flashcards" && (!Array.isArray(parsed.cards) || parsed.cards.length !== 3 ||
    parsed.cards.some((card) => typeof card.question !== "string" || typeof card.answer !== "string"))) {
    throw new ApiError(502, "The AI provider returned an incomplete flashcard set. Please try again.");
  }
  if (name === "quiz" && (!Array.isArray(parsed.questions) || parsed.questions.length !== 5 ||
    parsed.questions.some((question) => typeof question.q !== "string" || !Array.isArray(question.choices) ||
      question.choices.length !== 4 || !Number.isInteger(question.answer) || question.answer < 0 ||
      question.answer > 3 || typeof question.explain !== "string"))) {
    throw new ApiError(502, "The AI provider returned an incomplete quiz. Please try again.");
  }
  if (name === "facts" && (!Array.isArray(parsed.facts) || parsed.facts.length !== 3 ||
    parsed.facts.some((fact) => typeof fact.fact !== "string" || typeof fact.explanation !== "string"))) {
    throw new ApiError(502, "The AI provider returned incomplete facts. Please try again.");
  }
  return parsed;
}
 
function providerUrl(model) {
  const base = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  return `${base}/models/${encodeURIComponent(model)}:generateContent`;
}
 
function providerError(status, message) {
  if (status === 400 || status === 401 || status === 403) {
    return new ApiError(502, "Google Gemini rejected the API key or request. Check GEMINI_API_KEY and confirm the selected model is available to your Google AI project.");
  }
  if (status === 429 || status === 503 || /RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
    return new ApiError(503, "Google Gemini is rate-limiting requests or the project has reached its available quota. Check Google AI Studio usage limits and try again later.");
  }
  return new ApiError(502, `Google Gemini returned an error (${status}): ${message.slice(0, 400)}`);
}
 
async function providerRequest(body) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ApiError(503, "AI is not configured yet. Add GEMINI_API_KEY to .env and restart OrbitIQ.");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  let response;
  try {
    response = await fetch(providerUrl(model), {
      method: "POST",
      signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new ApiError(504, "The AI request timed out. Please try again.");
    }
    console.error("AI provider connection failed:", error.message);
    throw new ApiError(502, "Could not connect to the AI provider. Check the server connection and try again.");
  }
  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error
        ? [parsed.error.message, parsed.error.code, parsed.error.type].filter(Boolean).join(" ")
        : parsed.message || body;
    } catch {
      detail = body;
    }
    throw providerError(response.status, String(detail || "Unknown provider error"));
  }
  return response;
}
 
function inlineDataFromDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,([A-Za-z\d+/]+=*)$/.exec(dataUrl);
  if (!match) throw new ApiError(400, "The uploaded file could not be prepared for Google Gemini.");
  return { inlineData: { mimeType: match[1], data: match[2] } };
}
 
function geminiParts(input) {
  if (typeof input === "string") return [{ text: input }];
  if (!Array.isArray(input)) throw new ApiError(400, "The AI request content is invalid.");
  const content = input.find((item) => item.role === "user")?.content;
  if (!Array.isArray(content)) throw new ApiError(400, "The AI request content is invalid.");
  return content.map((part) => {
    if (part.type === "input_text") return { text: part.text };
    if (part.type === "input_image") return inlineDataFromDataUrl(part.image_url);
    if (part.type === "input_file") return inlineDataFromDataUrl(part.file_data);
    throw new ApiError(400, "The AI request contains an unsupported content type.");
  });
}
 
async function requestModel({ instructions, input, format }) {
  const body = {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: "user", parts: geminiParts(input) }],
    generationConfig: { maxOutputTokens: 2400 }
  };
  if (format) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = geminiSchema(schemas[format]);
  }
  const response = await providerRequest(body);
  let responseData;
  try {
    responseData = await response.json();
  } catch {
    throw new ApiError(502, "The AI provider returned an unreadable response.");
  }
  const text = responseText(responseData);
  return format ? parseStructuredOutput(text, format) : { text };
}
 
function learningInstructions(mode, subject, topic, learnerLevel) {
  const levelContext = learnerLevel ? ` The learner's selected study level is ${learnerLevel}; adjust vocabulary and depth to suit it.` : "";
  const shared = `You are OrbitIQ, a patient, accurate tutor helping a ${subject} learner. Explain clearly, use short steps and concrete examples, distinguish uncertainty, and never claim to have seen content that was not supplied. The current topic is: ${topic}.${levelContext}`;
  if (mode === "doubt") return `${shared} Answer the learner's specific question directly with an approachable explanation, a numbered reasoning path, and one short example or check-for-understanding. Do not invent course details.`;
  if (mode === "career") return `You are OrbitIQ's educational career exploration counsellor. The learner's selected study level is ${learnerLevel || "not specified"}. Treat all career matches as possibilities to explore, not predictions, diagnoses, or decisions. Use only the learner-provided context and your general knowledge; you have no live web access and must not invent current admissions, scholarships, deadlines, costs, salaries, job statistics, citations, or official requirements. Clearly label general guidance versus facts that need checking. Explain why options may fit, discuss qualifications as pathways that vary by institution and region, offer alternatives and practical age-appropriate next steps, and recommend checking official institution, government, and professional-body sources. Never guarantee admission, employment, income, or business success. For minors, keep projects safe and advise adult involvement for financial, legal, or contractual matters. Encourage discussion with a parent, teacher, or qualified counsellor for major decisions.`;
  if (mode === "homework") return `${shared} The learner wants help understanding an assignment. Do not provide a complete answer, final result, or ready-to-submit work. Instead, explain what the task asks, identify relevant concepts, outline a few guided steps with questions for the learner, and include a different, simple worked example.`;
  if (mode === "flashcards") return `${shared} Create exactly three concise question-and-answer flashcards. Test important ideas rather than trivia. Make each answer self-contained and suitable for active recall.`;
  if (mode === "quiz") return `${shared} Create exactly five accurate multiple-choice questions about the topic, each with exactly four distinct answer choices, one correct answer index from 0 to 3, and a brief explanation. Vary difficulty gently. Do not include trick questions or duplicate questions.`;
  return `${shared} Give exactly three engaging, accurate, age-appropriate facts about the topic, each with a short explanation. Avoid dubious superlatives.`;
}
 
async function handleLearn(request, response) {
  const body = await readJson(request);
  const mode = requiredText(body.mode, "Mode", 30);
  if (!["doubt", "homework", "flashcards", "quiz", "facts", "career"].includes(mode)) throw new ApiError(400, "Unsupported learning tool.");
  const subject = requiredText(body.subject, "Subject", 80);
  const topic = requiredText(body.topic, "Topic", 200);
  const learnerLevel = optionalText(body.learnerLevel, "Study level", 80);
  const instructions = learningInstructions(mode, subject, topic, learnerLevel);
  let input;
  let format;
  if (mode === "career") {
    const question = requiredText(body.question, "Question", 2000);
    const interests = optionalText(body.interests, "Career interests", 1200);
    input = `Learner's question:\n${question}\n\nInterests and preferences the learner chose to share:\n${interests || "Not provided"}\n\nGive a balanced, practical response. Explain uncertainty and do not claim to have researched current information.`;
  } else if (mode === "doubt") {
    input = requiredText(body.question, "Question", 3000);
  } else if (mode === "homework") {
    const assignment = requiredText(body.assignment, "Assignment", 5000);
    const stuckPoint = optionalText(body.stuckPoint, "Sticking point", 1000);
    input = `Assignment prompt:\n${assignment}\n\nWhere the learner is stuck:\n${stuckPoint || "Not specified"}`;
  } else if (mode === "flashcards") {
    input = "Return exactly three useful flashcards for this topic.";
    format = "flashcards";
  } else if (mode === "quiz") {
    input = "Return exactly five multiple-choice questions for this topic.";
    format = "quiz";
  } else {
    input = "Return exactly three accurate, engaging facts for this topic.";
    format = "facts";
  }
  const result = await requestModel({ instructions, input, format });
  sendJson(response, 200, result);
}
 
function toDataUrl(file) {
  return `data:${file.type};base64,${file.bytes.toString("base64")}`;
}
 
async function handleAnalyze(request, response) {
  const form = await readFormData(request);
  const subject = requiredText(form.get("subject"), "Subject", 80);
  const learnerLevel = optionalText(form.get("learnerLevel"), "Study level", 80);
  const text = optionalText(form.get("text"), "Text", MAX_TEXT_LENGTH);
  const frameTimestamps = optionalText(form.get("frameTimestamps"), "Frame timestamps", 200);
  const rawFile = form.get("file");
  const rawFrames = form.getAll("frame");
  const files = [];
  if (rawFile instanceof File && rawFile.size > 0) {
    files.push({ file: rawFile, kind: "file" });
  }
  const frameFiles = [];
  for (const frame of rawFrames) {
    if (frame instanceof File && frame.size > 0) frameFiles.push(frame);
  }
  if (frameFiles.length > 8) throw new ApiError(400, "Choose one file or up to eight video frames.");
  if (files.length && frameFiles.length) throw new ApiError(400, "Analyze either one file or sampled video frames, not both.");
  files.push(...frameFiles.map((file) => ({ file, kind: "frame" })));
  if (!text && files.length === 0) throw new ApiError(400, "Add text or choose a supported file to analyze.");
  let totalBytes = 0;
  const normalizedFiles = [];
  for (const item of files) {
    const { file, kind } = item;
    if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "Each uploaded file or video frame must be 12 MB or smaller.");
    totalBytes += file.size;
    if (totalBytes > MAX_UPLOAD_BYTES) throw new ApiError(413, "The combined upload size must be 12 MB or smaller.");
    const name = path.basename(file.name || "upload").replace(/[^\w.-]/g, "_").slice(0, 100);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (kind === "frame") {
      if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
        throw new ApiError(415, "Video frames must be JPEG, PNG, or WebP images.");
      }
      normalizedFiles.push({ kind, name, type: file.type, bytes });
      continue;
    }
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      normalizedFiles.push({ kind: "pdf", name, type: "application/pdf", bytes });
    } else if (file.type.startsWith("image/") && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      normalizedFiles.push({ kind: "image", name, type: file.type, bytes });
    } else if (file.type.startsWith("audio/") && ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/mpga", "audio/m4a", "audio/wav", "audio/x-wav", "audio/webm"].includes(file.type)) {
      normalizedFiles.push({ kind: "audio", name, type: file.type, bytes });
    } else {
      throw new ApiError(415, "This file type is not supported. Use text, PDF, JPEG/PNG/WebP images, audio, or a video with sampled frames.");
    }
  }
  if (normalizedFiles.filter((file) => file.kind === "audio").length > 1 ||
      normalizedFiles.filter((file) => file.kind === "pdf" || file.kind === "image").length > 1) {
    throw new ApiError(400, "Analyze one audio, image, or PDF at a time.");
  }
  const content = [];
  if (text) content.push({ type: "input_text", text: `Learner-provided notes or question:\n${text}` });
  for (const file of normalizedFiles) {
    if (file.kind === "audio") {
      content.push({ type: "input_file", filename: file.name, file_data: toDataUrl(file) });
    }
    if (file.kind === "image" || file.kind === "frame") {
      content.push({
        type: "input_image",
        image_url: toDataUrl(file),
        detail: "auto"
      });
    }
    if (file.kind === "pdf") {
      content.push({
        type: "input_file",
        filename: file.name,
        file_data: toDataUrl(file)
      });
    }
  }
  const hasFrames = normalizedFiles.some((file) => file.kind === "frame");
  if (hasFrames && frameTimestamps) {
    content.push({ type: "input_text", text: `The sampled video frames appear in chronological order at approximately: ${frameTimestamps}.` });
  }
  const prompt = hasFrames
    ? "Explain the supplied video frames in order. Summarize the visible sequence, explain important ideas in simple language, and note any uncertainty caused by missing frames. Use any accompanying text as context."
    : normalizedFiles.some((file) => file.kind === "audio")
      ? "Listen to the supplied audio, briefly summarize what was said, and explain its main ideas in simple language with a short example. Base the explanation only on the supplied material and be clear about uncertainty."
      : "Explain the supplied study material in simple language. Identify its main idea, clarify unfamiliar terms or steps, and provide a short example. Base the explanation only on the supplied material and be clear about uncertainty.";
  content.push({ type: "input_text", text: prompt });
  const result = await requestModel({
    instructions: `You are OrbitIQ, a patient ${subject} tutor. ${learnerLevel ? `The learner's selected study level is ${learnerLevel}; adjust vocabulary and depth to suit it. ` : ""}Help the learner understand the supplied material rather than merely restating it. Be accurate and clear.`,
    input: [{ role: "user", content }]
  });
  sendJson(response, 200, result);
}
 
function securityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}
 
function getBrowserId(request) {
  const cookies = Object.fromEntries((request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim().split(/=(.*)/s, 2))
    .filter(([name, value]) => name && value !== undefined));
  const browserId = cookies[BROWSER_COOKIE];
  return BROWSER_ID_PATTERN.test(browserId || "") ? browserId : null;
}
 
function getCookie(request, name) {
  return (request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;
}
 
function isSecureRequest(request) {
  if (request.socket.encrypted) return true;
  if (process.env.TRUST_PROXY !== "true") return false;
  return (request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
}
 
function setBrowserCookie(request, response, browserId) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${BROWSER_COOKIE}=${browserId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`
  );
}
 
function setSessionCookie(request, response, token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}
 
function clearSessionCookie(request, response) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
 
const hashSessionToken = (token) => createHash("sha256").update(token).digest("hex");
const hashVerificationCode = (code, salt) => scryptSync(code, salt, 32).toString("hex");
 
function parseEmail(value) {
  if (typeof value !== "string") throw new ApiError(400, "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "Enter a valid email address.");
  }
  return email;
}
 
function parseAccountProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Complete the profile details to create an account.");
  }
  const name = requiredText(value.name, "Name", 50);
  const age = Number(value.age);
  if (!Number.isInteger(age) || age < 5 || age > 120) throw new ApiError(400, "Enter an age between 5 and 120.");
  const allowedRoles = ["School student", "College student", "Other"];
  if (!allowedRoles.includes(value.role)) throw new ApiError(400, "Choose a valid account category.");
  return {
    role: value.role,
    name,
    age,
    institution: optionalText(value.institution, "School or college", 120),
    level: optionalText(value.level, "Study level", 80) || "Other / lifelong learner"
  };
}
 
function createMailer() {
  return async ({ email, code, mode }) => {
    const user = process.env.GMAIL_USER;
    const password = process.env.GMAIL_APP_PASSWORD;
    if (!user || !password) {
      throw new ApiError(503, "Email verification is not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env, then restart OrbitIQ.");
    }
    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: password.replace(/\s/g, "") }
    });
    return transport.sendMail({
      from: user,
      to: email,
      subject: "Your OrbitIQ verification code",
      text: `Your OrbitIQ ${mode === "signup" ? "sign-up" : "sign-in"} verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<p>Your OrbitIQ ${mode === "signup" ? "sign-up" : "sign-in"} verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:5px">${code}</p><p>It expires in 10 minutes. If you did not request this code, you can ignore this email.</p>`
    });
  };
}
 
function checkAuthRequestLimit(request, email, limits) {
  const now = Date.now();
  const keys = [
    { key: `email:${email}`, limit: 5 },
    { key: `client:${getClientKey(request)}`, limit: 15 }
  ];
  for (const { key, limit } of keys) {
    const current = limits.get(key);
    if (!current || now - current.startedAt >= AUTH_RATE_WINDOW_MS) {
      limits.set(key, { startedAt: now, count: 1 });
    } else {
      current.count += 1;
      if (current.count > limit) {
        throw new ApiError(429, "Too many code requests. Please wait and try again.");
      }
    }
  }
  if (limits.size > 5000) {
    for (const [entryKey, entry] of limits) {
      if (now - entry.startedAt >= AUTH_RATE_WINDOW_MS) limits.delete(entryKey);
    }
  }
}
 
async function requireSession(request, response, database) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[\w-]{40,60}$/.test(token)) throw new ApiError(401, "Sign in with your email to continue.");
  const tokenHash = hashSessionToken(token);
  const session = database.getSession(tokenHash);
  if (!session) {
    database.deleteSession(tokenHash);
    clearSessionCookie(request, response);
    throw new ApiError(401, "Your session has expired. Sign in again to continue.");
  }
  return { ...session, tokenHash };
}
 
// CHANGE 2: behind a trusted proxy, compare the Origin with the public host
// (x-forwarded-host) so signup/verify/logout work on orbitiq.online.
function sameOriginRequest(request) {
  const origin = request.headers.origin;
  const forwardedHost = process.env.TRUST_PROXY === "true"
    ? String(request.headers["x-forwarded-host"] || "").split(",")[0].trim()
    : "";
  const host = forwardedHost || request.headers.host;
  if (!origin || !host) return false;
  try {
    const protocol = isSecureRequest(request) ? "https:" : "http:";
    return new URL(origin).origin === `${protocol}//${host}`;
  } catch {
    return false;
  }
}
 
function parseBrowserState(body) {
  const profile = body.profile;
  const data = body.data;
  if (profile !== null && (!profile || typeof profile !== "object" || Array.isArray(profile))) {
    throw new ApiError(400, "Profile must be an object or null.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError(400, "Study data must be an object.");
  }
  if (profile && (typeof profile.name !== "string" || profile.name.length > 100)) {
    throw new ApiError(400, "Profile name is invalid.");
  }
  const profileBytes = Buffer.byteLength(JSON.stringify(profile ?? null));
  const dataBytes = Buffer.byteLength(JSON.stringify(data));
  if (profileBytes > MAX_PROFILE_BYTES) throw new ApiError(413, "Profile data is too large.");
  if (dataBytes > MAX_STUDY_DATA_BYTES) throw new ApiError(413, "Study data is too large.");
  return { profile, data };
}
 
function createServer({ databasePath, sendVerificationCode } = {}) {
  // CHANGE 3: DATABASE_PATH lets you keep the database file outside the
  // project folder so redeploys don't erase accounts. Unset = old behavior.
  const databasePromise = openDatabase(databasePath || process.env.DATABASE_PATH || undefined);
  const authRateLimits = new Map();
  const deliverVerificationCode = sendVerificationCode || createMailer();
  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const database = await databasePromise;
        const browserId = getBrowserId(request) || randomUUID();
        if (!getBrowserId(request)) setBrowserCookie(request, response, browserId);
        const token = getCookie(request, SESSION_COOKIE);
        if (!token || !/^[\w-]{40,60}$/.test(token)) {
          if (token) clearSessionCookie(request, response);
          return sendJson(response, 200, { user: null });
        }
        const session = database.getSession(hashSessionToken(token));
        if (!session) {
          database.deleteSession(hashSessionToken(token));
          clearSessionCookie(request, response);
          return sendJson(response, 200, { user: null });
        }
        return sendJson(response, 200, {
          user: { email: session.user.email, profile: session.user.profile },
          state: database.getUserState(session.user.id)
        });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/request-code") {
        if (!sameOriginRequest(request)) throw new ApiError(403, "Account requests can only be made from this application.");
        const body = await readJson(request);
        const email = parseEmail(body.email);
        const mode = body.mode;
        if (mode !== "signup" && mode !== "login") throw new ApiError(400, "Choose sign in or create account.");
        const profile = mode === "signup" ? parseAccountProfile(body.profile) : null;
        checkAuthRequestLimit(request, email, authRateLimits);
        const database = await databasePromise;
        const previous = database.getVerificationCode(email);
        if (previous && Date.now() - previous.sentAt < 45_000) {
          throw new ApiError(429, "Please wait a moment before requesting another code.");
        }
        const code = String(randomInt(100000, 1000000));
        const salt = randomBytes(16).toString("hex");
        const sentAt = Date.now();
        database.saveVerificationCode(email, {
          hash: hashVerificationCode(code, salt),
          salt,
          mode,
          profile,
          expiresAt: sentAt + VERIFICATION_CODE_TTL_MS,
          sentAt
        });
        try {
          await deliverVerificationCode({ email, code, mode });
        } catch (error) {
          database.deleteVerificationCode(email);
          if (error instanceof ApiError) throw error;
          console.error("Could not deliver a OrbitIQ verification email:", error.message);
          throw new ApiError(502, "OrbitIQ could not send the verification email. Check the Gmail settings and try again.");
        }
        const browserId = getBrowserId(request) || randomUUID();
        if (!getBrowserId(request)) setBrowserCookie(request, response, browserId);
        return sendJson(response, 200, { message: "If this email can be used for this request, a verification code has been sent." });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/verify-code") {
        if (!sameOriginRequest(request)) throw new ApiError(403, "Verification can only be completed from this application.");
        const body = await readJson(request);
        const email = parseEmail(body.email);
        if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) throw new ApiError(400, "Enter the six-digit code from your email.");
        const database = await databasePromise;
        const record = database.getVerificationCode(email);
        if (!record || record.expiresAt <= Date.now() || record.attempts >= MAX_VERIFICATION_ATTEMPTS) {
          if (record) database.deleteVerificationCode(email);
          throw new ApiError(401, "That code is invalid or expired. Request a new code and try again.");
        }
        const suppliedHash = Buffer.from(hashVerificationCode(body.code, record.salt), "hex");
        const expectedHash = Buffer.from(record.hash, "hex");
        if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
          database.incrementVerificationAttempts(email);
          if (record.attempts + 1 >= MAX_VERIFICATION_ATTEMPTS) database.deleteVerificationCode(email);
          throw new ApiError(401, "That code is invalid or expired. Request a new code and try again.");
        }
        let user = database.getUserByEmail(email);
        if (record.mode === "signup") {
          if (user) {
            database.deleteVerificationCode(email);
            throw new ApiError(409, "An account already exists for this email. Choose sign in instead.");
          }
          user = database.createUser(randomUUID(), email, record.profile);
          const legacyState = getBrowserId(request) ? database.claimBrowserState(getBrowserId(request)) : null;
          if (legacyState) database.saveUserState(user.id, legacyState.data);
        } else if (!user) {
          database.deleteVerificationCode(email);
          throw new ApiError(401, "That code is invalid or expired. Check the email or create a new account.");
        }
        database.deleteVerificationCode(email);
        const token = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + SESSION_TTL_MS;
        database.createSession(hashSessionToken(token), user.id, expiresAt);
        setSessionCookie(request, response, token);
        return sendJson(response, 200, {
          user: { email: user.email, profile: user.profile },
          state: database.getUserState(user.id)
        });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        if (!sameOriginRequest(request)) throw new ApiError(403, "Sign out can only be completed from this application.");
        const token = getCookie(request, SESSION_COOKIE);
        if (token && /^[\w-]{40,60}$/.test(token)) {
          const database = await databasePromise;
          database.deleteSession(hashSessionToken(token));
        }
        clearSessionCookie(request, response);
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/api/data" && request.method === "GET") {
        const database = await databasePromise;
        const session = await requireSession(request, response, database);
        return sendJson(response, 200, { state: { profile: session.user.profile, ...database.getUserState(session.user.id) } });
      }
      if (url.pathname === "/api/data" && request.method === "PUT") {
        if (!sameOriginRequest(request)) throw new ApiError(403, "Study data can only be saved from this application.");
        const body = await readJson(request);
        const state = parseBrowserState(body);
        const database = await databasePromise;
        const session = await requireSession(request, response, database);
        if (!state.profile) throw new ApiError(400, "An account profile is required.");
        database.updateUserProfile(session.user.id, parseAccountProfile(state.profile));
        database.saveUserState(session.user.id, state.data);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          configured: Boolean(process.env.GEMINI_API_KEY),
          model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
        });
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/OrbitIQ_Favicon.png") {
        const favicon = fs.readFileSync(path.join(ROOT, "OrbitIQ_Favicon.png"));
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": favicon.length,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff"
        });
        response.end(request.method === "HEAD" ? undefined : favicon);
        return;
      }
      if (request.method === "POST" && ["/api/learn", "/api/analyze"].includes(url.pathname)) {
        const database = await databasePromise;
        await requireSession(request, response, database);
        checkRateLimit(request);
        if (url.pathname === "/api/learn") return await handleLearn(request, response);
        return await handleAnalyze(request, response);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "Method not allowed." });
      }
      if (url.pathname !== "/" && url.pathname !== "/index.html") {
        return sendJson(response, 404, { error: "Not found." });
      }
      const file = fs.readFileSync(path.join(ROOT, "index.html"));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": file.length,
        "cache-control": "no-store"
      });
      response.end(request.method === "HEAD" ? undefined : file);
    } catch (error) {
      if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
      console.error("OrbitIQ request failed:", error);
      return sendJson(response, 500, { error: "OrbitIQ encountered an unexpected server error. Please try again." });
    }
  });
  server.on("close", async () => {
    const database = await databasePromise;
    database.close();
  });
  return server;
}
 
if (require.main === module) {
  loadEnvFile();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`OrbitIQ is running at http://${host}:${port}`);
    if (!process.env.GEMINI_API_KEY) console.warn("AI is not configured. Add GEMINI_API_KEY to .env and restart the server.");
  });
}
 
module.exports = { createServer, loadEnvFile };
 