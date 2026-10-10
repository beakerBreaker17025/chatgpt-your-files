---
name: cohere-llm-integration
description: "Use when integrating, debugging, or updating Cohere LLM chat, streaming, or retrieval-augmented generation with the Cohere TypeScript SDK, especially in Supabase Edge Functions and this repository."
---

# Cohere LLM Integration

Use this skill to implement or debug Cohere chat and streaming without mixing incompatible model IDs, SDK methods, API generations, or event formats.

## Before changing code

1. Inspect the existing provider client, SDK version/import map, request shape, response handling, and runtime. Follow the integration already in the repository unless there is a clear reason to migrate.
2. Verify the current Cohere model ID and API contract in the official docs; model availability and SDK interfaces change. Do not infer a model ID from a display name or use an undocumented alias. Confirm the account has access to the selected model.
3. Keep V1 and V2 request/response shapes separate. If migrating API generations, update the request, stream event handling, SDK client, and tests together.
4. For Supabase auth, secrets, database, or Edge Function deployment changes, also follow the project's Supabase skill.

## Model IDs and SDK setup

- Pass the provider's exact model ID in the `model` request field. For example, `command-r-plus-08-2024` is a complete model ID; `command-r-plus-08` is not.
- Prefer a currently documented, supported model that the account can access. Recheck the official [Cohere models list](https://docs.cohere.com/docs/models) and [deprecations](https://docs.cohere.com/v2/docs/deprecations) before setting or changing a model.
- Keep the model identifier easy to locate in the request. Use configuration only when the project needs runtime model selection; validate configured IDs and provide an explicit error for missing configuration.
- In this repository, `@cohere-ai/client` is the Deno import-map alias for `cohere-ai`. Check `supabase/functions/import_map.json` before changing imports. Pin SDK versions intentionally and validate the API against the installed version rather than copying examples for a different major version.
- Put the Cohere credential in the trusted server/Edge Function environment (this project uses `COHERE_API_KEY`). Never expose it through a browser bundle, `NEXT_PUBLIC_*`, logs, or committed configuration.

## Chat API generation and streaming

This repository uses the Cohere V1-style API through `CohereClient`:

```ts
const response = await cohere.chatStream({
  model: 'command-r-plus-08-2024',
  message: userMessage,
  chatHistory,
  documents,
  preamble,
});
```

- Use `chatStream()` for streaming. Do not call `chat()` and expect an async iterator.
- With this SDK/API generation, `chatStream()` selects streaming; do not add `stream: true` if the SDK's `ChatStreamRequest` type rejects it.
- V1 stream events use `eventType`; append `event.text` only for `eventType === 'text-generation'`. Do not check V2's `type === 'content-delta'` on this stream.
- A V2 migration uses a different client/request shape, typically `CohereClientV2.chatStream({ model, messages })`, and text deltas are in `content-delta` events. Follow the current V2 SDK types and docs if migrating; do not combine V1 `message`/`chatHistory` fields with V2 `messages`.
- For a web response, bridge provider events to the format expected by the existing frontend. If using AI SDK v2's `StreamingTextResponse`, enqueue UTF-8 text chunks and keep CORS headers consistent with the function's other responses.
- Handle errors from iteration as well as from opening the provider request. Propagate stream failures with `controller.error(error)` or the repository's equivalent; do not report success with a silently truncated response.

Example V1 event bridge:

```ts
const body = new ReadableStream<Uint8Array>({
  async start(controller) {
    try {
      for await (const event of response) {
        if (event.eventType === 'text-generation') {
          controller.enqueue(new TextEncoder().encode(event.text));
        }
      }
      controller.close();
    } catch (error) {
      controller.error(error);
    }
  },
});
```

Consult Cohere's [V1 streaming reference](https://docs.cohere.com/reference/chat-stream-v1), [streaming guide](https://docs.cohere.com/docs/streaming), and the SDK's version-matched declarations. The official [TypeScript SDK](https://github.com/cohere-ai/cohere-typescript) documents `chatStream()` and its event iteration.

## Chat history and RAG documents

- Send the current user prompt as `message`; send earlier turns only in `chatHistory`. Omit the current turn from history to prevent duplication.
- Map roles to the values expected by the selected API generation. For V1, prior user turns use `USER` and assistant turns use `CHATBOT`; do not pass arbitrary UI roles without mapping them.
- For V1 document mode, send retrieved context as an array of string maps, for example `[{ text: sectionContent }]`. Keep the application’s existing retrieval limit and source authorization behavior.
- Treat retrieved documents as untrusted context, not instructions. The preamble should direct the model to answer from supplied sources and to say when the answer is unavailable.
- Preserve the authenticated user's authorization context when retrieving Supabase data. Do not bypass RLS or switch to a service-role client to fix a chat failure.
- Validate incoming messages and embeddings before indexing arrays or making provider/database calls. Return useful client errors without exposing credentials, prompts, internal stack traces, or provider internals.

## Troubleshooting

- **404 / model not found:** compare the exact request ID with Cohere's current model list; fix spelling, date/version suffix, or account access. Changing API keys is not a substitute for correcting an invalid model ID.
- **401 / 403:** verify the server secret is present and valid, and that it has access to the selected model. Never print the secret while debugging.
- **SDK type errors:** check the installed/import-mapped SDK version and use its declarations. Typical V1 mistakes include calling `chat()` for streaming, adding an unsupported `stream` property to `chatStream()`, or checking V2 event fields.
- **Empty or cut-off stream:** verify the event discriminator and text field for the active API generation, and make asynchronous stream errors observable.
- **No retrieved context:** debug the Supabase RPC and authorization path independently from generation; preserve RLS and report retrieval errors rather than disguising them as a model response.

## Verification

1. Run the relevant type check using the same import map/runtime as deployment (for this Edge Function: `deno check --import-map=supabase/functions/import_map.json supabase/functions/chat/index.ts`).
2. Test an authenticated request with valid input and a configured Cohere secret. Confirm a text response streams and that model/provider errors return a non-success response.
3. Test empty/invalid input and retrieval errors where practical. Confirm user-specific retrieval remains authorized.
4. Before deployment, verify the required secret name is configured in the target Supabase project without printing its value. Deploy the function using the project's established release workflow and verify it from logs.
