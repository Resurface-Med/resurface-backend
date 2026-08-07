# resurface-backend

API for Resurface. Next.js on Vercel. Exists so the Anthropic key lives on a
server instead of in a browser bundle.

Related repos: `resurface-app`, `resurface-landing`.

---

## Where this sits

```
resurface-app (browser)
      │  POST /api/generate  + x-resurface-passcode
      ▼
  this service ──── ANTHROPIC_API_KEY ───▶ Claude
      │
      └─ builds the system prompt server-side, so the endpoint
         can only ever produce MBChB questions
```

The app parses uploads (PowerPoint, PDF, images) in the browser and sends the
extracted content here. This service never sees a file, only the content blocks
bound for the model.

## Running locally

```bash
npm install
cp .env.example .env.local
npm run dev            # http://localhost:3001
```

`ALLOWED_ORIGINS` must include the app's dev origin (`http://localhost:5173`) or
the browser will block every response.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/generate` | Generates MCQs. Requires `x-resurface-passcode`. |
| `OPTIONS` | `/api/generate` | CORS preflight. |

Request body is `{ userContent, difficulty, count }`, where `userContent` is an
array of Anthropic content blocks. `count` is clamped to 20.

## Why the prompt is built here

If the client sent the system prompt, anyone with the access code would have a
free general-purpose Claude proxy. Building it server-side means the worst case
is someone generating medical questions they didn't want.

## Known gaps

- **Rate limiting is in-memory** and resets whenever an instance goes cold. It
  stops runaway loops, not a leaked access code. Upstash Redis is the fix.
- **The access code is shared**, not per-user, so it cannot be revoked for one
  person. It is a bill guard, not authentication.
- No auth, no database, no progress sync yet — the reason this repo is separate
  from the app is that those are coming, not that they exist.

## Out of scope

Not a general LLM gateway, and not a content API — the question bank still ships
inside `resurface-app`.
