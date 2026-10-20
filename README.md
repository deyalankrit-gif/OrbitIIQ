# StudyOrbit

StudyOrbit is a Node.js app. The browser talks to a same-origin backend; the backend keeps the Google Gemini API key off the client, forwards learning requests to Gemini, and persists the profile and study data in a local SQLite database.

## Run locally

1. Install Node.js 20 or newer.
2. Install dependencies:

   ```powershell
   npm install
   ```
3. Copy `.env.example` to `.env` only if you do not already have a local `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

   Create a Google Gemini API key at <https://aistudio.google.com/app/apikey> and set `GEMINI_API_KEY` in `.env`. The default model is `gemini-2.5-flash`; optionally set `GEMINI_MODEL` and `DATABASE_PATH`. Never commit or share `.env`.
4. Start StudyOrbit:

   ```powershell
   npm start
   ```
5. Open <http://127.0.0.1:3000>.

Do not use VS Code Live Server (usually port `5500`) or the Next.js landing page for the AI tools: those servers do not expose the legacy app's AI API. If port `3000` is already occupied, start the legacy app on another port:

```powershell
$env:PORT=3001
npm start
```

Then open the URL printed by the server (for example, <http://127.0.0.1:3001>). The app's theme selector offers White, Black, and System; the choice is saved in this browser.

AI tools require a Google Gemini API key with access and available quota for the selected model. The **AI key configured** status only confirms a key is present; the first AI request confirms provider access and usage. If Gemini reports a quota or rate limit, check the Google AI Studio project limits. `npm test` runs the backend tests without contacting an AI provider.

The Sign out control removes the saved profile from this browser while retaining study data. This is a local-profile convenience, not authentication or a security boundary; the prototype has no user accounts or protected sessions.

## AI tools and uploaded files

- Doubt clearer, flashcards, quizzes, fun facts, and learning-first homework guidance use the configured Gemini model.
- Text, images, PDFs, and audio are sent to Gemini for analysis. Video stays in the browser; up to six sampled still frames are sent for visual explanation. Audio tracks in videos are not transcribed.
- Uploaded material is held in memory for the request and is not stored by this application. Your name, age, and school/college are not sent to the AI provider; the selected study level, subject, topic, question, and submitted material are. AI provider data handling is subject to that provider's policies.
- Requests are size-limited and rate-limited per client address. This local prototype does not include user accounts or production authentication. Do not expose it to the public internet without adding authentication, HTTPS, durable per-user limits, and an appropriate data-retention policy.

## Exam Center

The Exam Center is a personal tracker for school exams, Olympiads, scholarships, entrance opportunities, and coding/STEM competitions. Add exam dates, registration deadlines, an official source link, and any syllabus topics you have verified. Unknown dates remain unannounced; StudyOrbit does not infer or fabricate exam information.

Use the preparation-plan checklist to organize revision, or generate a five-question AI practice quiz from an exam's subject and saved topics. Exam records, saved items, plan progress, and quiz scores are saved in the local SQLite database and cached in this browser's local storage. On first launch, existing local browser data is imported into the database.

The Exam Center does not yet collect live announcements, verify eligibility, send reminders, or synchronize across devices. The database is a local prototype store scoped by an opaque browser cookie; it is not user authentication, encryption, or a multi-user access-control system. The server binds to localhost by default. Keep the database file private and back it up if needed. Always check dates and requirements on the official organizer's website. A source can only be marked checked by the person entering the record; StudyOrbit does not independently validate it.

## New Next.js foundation

The replacement application is being developed separately in [`web/`](./web/README.md). The existing browser app remains available as the legacy prototype. The current prototype does not have accounts or a logout/session system.
