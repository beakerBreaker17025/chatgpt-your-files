# Codebase context

## Project

This repository is a fork of [supabase-community/chatgpt-your-files](https://github.com/supabase-community/chatgpt-your-files). It is a web app for uploading Markdown documents and asking questions about their contents. The application uses retrieval-augmented generation (RAG): document text is split into sections, embedded, searched by vector similarity, and supplied as context to a streaming chat completion.

## Stack

- Next.js App Router and React, written in TypeScript.
- Supabase Auth, Postgres with pgvector, Storage, and Edge Functions.
- Tailwind CSS and Radix-based UI components.
- Transformers.js (`Supabase/gte-small`) generates query embeddings in a browser Web Worker; Supabase AI generates document-section embeddings.
- The chat Edge Function calls the Cohere API.

## Main areas

- `app/`: Next.js routes and layouts. `/files` handles document upload/list/download; `/chat` hosts the chat UI; `/login` handles authentication.
- `components/`: shared components and UI primitives.
- `lib/`: client providers, hooks, worker integration, and shared utilities.
- `supabase/migrations/`: database schema, RLS policies, storage processing trigger, embedding trigger, and vector match function.
- `supabase/functions/process/`: downloads an uploaded Markdown file, splits it into sections, and stores them.
- `supabase/functions/embed/`: generates and saves vector embeddings for stored sections.
- `supabase/functions/chat/`: finds relevant sections and streams an answer using Cohere.
- `supabase/functions/_lib/`: Markdown parser and shared Supabase database types.
- `sample-files/`: sample Markdown documents.

## Data flow

1. An authenticated user uploads a file to the Supabase `files` Storage bucket.
2. The database trigger creates a `documents` row and invokes the `process` Edge Function.
3. `process` parses Markdown into heading-based sections (with long sections chunked) and inserts them into `document_sections`.
4. A database trigger invokes `embed` to create normalized 384-dimensional `gte-small` embeddings.
5. In `/chat`, the browser embeds the user's question and sends it with the authenticated session to the `chat` Edge Function.
6. `chat` calls `match_document_sections`, supplies up to five matching sections to a Cohere chat completion, and streams the response.

User-owned data is protected by Postgres row-level security. Preserve the authenticated-user context when changing database queries, Storage access, triggers, or Edge Function calls.

## Local development

- Install dependencies with `npm install`.
- Start the local Supabase stack with `npx supabase start` (Docker required).
- Copy the local Supabase URL and public anon key into `.env.local`; `.env.local.example` shows the required variable names.
- Put `COHERE_API_KEY` in `supabase/functions/.env` for local Edge Function chat requests. Never commit secrets or expose service-role keys in browser code.
- Run the app with `npm run dev`.
- `npm run build` builds the Next.js app; `npm start` serves the production build.
- `npm run gen:types` regenerates `supabase/functions/_lib/database.ts` from the local database after schema changes.

The Supabase CLI can serve and monitor local Edge Functions with `npx supabase functions serve`; the local stack also serves them. See `README.md` for the full Supabase setup and deployment walkthrough.

## Working conventions

- Keep TypeScript strict and use the existing `@/` path alias.
- Make schema changes in new SQL migrations under `supabase/migrations/`; keep RLS policies in sync with data-access changes.
- Regenerate database types after schema changes rather than hand-editing generated definitions.
- Keep the browser and server embedding model, normalization, and vector dimensions compatible with the database and `match_document_sections` function.
- There are no test or lint scripts defined in `package.json`; validate changes with the relevant available build/type checks and focused manual checks.
