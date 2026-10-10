---
name: supabase-free-tier-rag
description: Build RAG ingestion and retrieval on Supabase Free tier using pgvector, pg_cron queues, and CPU‑safe Edge Functions with native AI inference. Explicitly designed for Free tier constraints (2s CPU, 150s wall clock, 500k invocations/month).
tags:
  - supabase
  - rag
  - pgvector
  - edge-functions
  - free-tier
  - embeddings
  - ai-inference
version: 1.0.0
---

# Supabase Free‑Tier RAG Architecture Skill

> This architecture is **only designed for Supabase Free tier**. It assumes 2s CPU time per Edge Function request, 150s wall‑clock timeout, and 500k Edge Function invocations/month. Do not use this skill for Pro/Enterprise workloads without adapting batch sizes, scheduling, and limits.

## Goal

Provide a production‑style, CPU‑safe RAG pipeline on Supabase Free tier that:

- Avoids `shutdown (reason: CPU time limit reached)` when generating embeddings.
- Uses **async, queue‑driven embedding generation** via `pg_cron` + Edge Functions.
- Leverages **Supabase native AI inference** (`Supabase.ai`) for embeddings to stay under 2s CPU.
- Keeps query‑time retrieval fast and lightweight.

## When to Use This Skill

Use this skill when the user:

- Is on **Supabase Free tier** and building a RAG app with pgvector.
- Wants to ingest documents/chunks and generate embeddings without hitting CPU limits.
- Needs a simple, Supabase‑only architecture (no external compute like Cloud Run).
- Accepts eventual consistency for embeddings (background processing via cron).

Do **not** use this skill if:

- The user is on Pro/Enterprise and needs higher throughput or stricter SLAs.
- The user requires real‑time embedding generation in the request path.
- The user wants to run custom Transformers.js / WASM models in Edge Functions for embeddings.

## Core Constraints (Free Tier)

- **CPU time**: 2 seconds per Edge Function request (hard limit). [1][2]
- **Wall‑clock timeout**: 150 seconds per request on Free tier. [1][3]
- **Edge Function invocations**: 500,000 / month included. [4][5]
- **Database**: 500 MB; projects pause after 7 days of inactivity. [6]

This skill’s patterns are explicitly tuned to these constraints.

## Architecture Overview

1. **Documents table** with `pgvector` embedding column and status tracking.
2. **Triggers** that enqueue embedding jobs whenever `content` changes.
3. **`embedding_jobs` queue table** to track pending/processing/failed jobs.
4. **`pg_cron` schedule** that periodically invokes an Edge Function to process a small batch of jobs.
5. **Edge Function worker** that:
   - Fetches a small batch of queued jobs.
   - Calls `Supabase.ai.embed()` for each document.
   - Updates the embedding and job status.
6. **Query Edge Function** that:
   - Embeds the user query via `Supabase.ai.embed()`.
   - Runs a `pgvector` similarity search.
   - Returns top‑K chunks for LLM context.

This matches Supabase’s “Automatic Embeddings” pattern and avoids CPU timeouts by keeping each invocation small and using native inference. [7][8][9]

## Files and References This Skill Manages

You may create or update:

- `references/schema.sql` – SQL for `documents`, `embedding_jobs`, triggers, and helper RPCs.
- `references/ingestion.md` – Notes on chunking strategy, batch sizes, and cron schedule.
- `supabase/functions/process-embeddings-batch/index.ts` – Batch embedding worker.
- `supabase/functions/retrieve-context/index.ts` – Query‑time retrieval function.
- `.env.local` or project docs – Required env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, etc.).

## Implementation Checklist

### 1. Database Schema

Ensure the following exist in the user’s Supabase project:

```sql
create extension if not exists vector;
create extension if not exists pg_cron;
create extension if not exists supabase_functions;
```

Tables:

```sql
create table documents (
  id bigserial primary key,
  content text not null,
  embedding vector(1536),  -- adjust dimension to model
  status text default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table embedding_jobs (
  doc_id bigint primary key,
  status text default 'queued', -- queued | processing | done | failed
  attempts int default 0,
  last_error text,
  updated_at timestamptz default now()
);
```

Triggers:

```sql
create or replace function queue_embedding_job()
returns trigger as $$
begin
  insert into embedding_jobs (doc_id, status)
  values (new.id, 'queued')
  on conflict (doc_id) do update set status = 'queued';
  return new;
end;
$$ language plpgsql;

create trigger trg_queue_embedding
after insert or update of content on documents
for each row
execute function queue_embedding_job();
```

Helper RPC to update embeddings:

```sql
create or replace function update_document_embedding(
  p_doc_id bigint,
  p_embedding vector(1536)
) returns void as $$
begin
  update documents
  set embedding = p_embedding,
      status = 'done',
      updated_at = now()
  where id = p_doc_id;

  update embedding_jobs
  set status = 'done',
      updated_at = now()
  where doc_id = p_doc_id;
end;
$$ language plpgsql;
```

### 2. Cron Schedule

Create a `pg_cron` job that calls the Edge Function every 5 minutes (or as appropriate):

```sql
select cron.schedule(
  'process-embedding-jobs',
  '*/5 * * * *',
  $$
    select supabase_functions.invoke(
      'process-embeddings-batch',
      'POST',
      json_build_object(
        'batch_size', 10
      )
    );
  $$
);
```

Adjust `batch_size` based on observed CPU usage and throughput needs. Keep it small enough that the Edge Function stays under 2s CPU. [1][2]

### 3. Edge Function: `process-embeddings-batch`

Create `supabase/functions/process-embeddings-batch/index.ts`:

```ts
import { createClient } from '[https://esm.sh/@supabase/supabase-js@2](https://esm.sh/@supabase/supabase-js@2)'
import { SupabaseAI } from '[https://esm.sh/@supabase/ai@1](https://esm.sh/@supabase/ai@1)'

export default async function (req: Request) {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!
  )
  const ai = new SupabaseAI()

  const { batch_size = 10 } = await req.json()

  const { data: jobs, error } = await supabase
    .from('embedding_jobs')
    .select('doc_id')
    .eq('status', 'queued')
    .limit(batch_size)

  if (error || !jobs?.length) {
    return new Response('no jobs', { status: 200 })
  }

  for (const { doc_id } of jobs) {
    try {
      // Mark as processing
      await supabase
        .from('embedding_jobs')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('doc_id', doc_id)

      const { data: doc, error: docErr } = await supabase
        .from('documents')
        .select('content')
        .eq('id', doc_id)
        .single()

      if (docErr || !doc) {
        throw new Error('document not found')
      }

      const embedding = await ai.embed(doc.content)

      await supabase.rpc('update_document_embedding', {
        p_doc_id: doc_id,
        p_embedding: embedding
      })
    } catch (err) {
      const attempts = (
        await supabase
          .from('embedding_jobs')
          .select('attempts')
          .eq('doc_id', doc_id)
          .single()
      ).data?.attempts ?? 0

      if (attempts >= 3) {
        await supabase
          .from('embedding_jobs')
          .update({
            status: 'failed',
            last_error: String(err),
            updated_at: new Date().toISOString()
          })
          .eq('doc_id', doc_id)
      } else {
        await supabase
          .from('embedding_jobs')
          .update({
            status: 'queued',
            attempts: attempts + 1,
            last_error: String(err),
            updated_at: new Date().toISOString()
          })
          .eq('doc_id', doc_id)
      }
    }
  }

  return new Response('ok', { status: 200 })
}
```

Key points:

- Uses **native AI inference** (`ai.embed`) to stay within 2s CPU. [9]
- Processes a **small batch** to keep CPU low and predictable.
- Implements simple retry logic with a max attempt count.

### 4. Edge Function: `retrieve-context`

Create `supabase/functions/retrieve-context/index.ts`:

```ts
import { createClient } from '[https://esm.sh/@supabase/supabase-js@2](https://esm.sh/@supabase/supabase-js@2)'
import { SupabaseAI } from '[https://esm.sh/@supabase/ai@1](https://esm.sh/@supabase/ai@1)'

export default async function (req: Request) {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!
  )
  const ai = new SupabaseAI()

  const { query, top_k = 5 } = await req.json()

  if (!query) {
    return new Response(JSON.stringify({ error: 'query required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  }

  const embedding = await ai.embed(query)

  const { data, error } = await supabase.rpc('search_documents', {
    query_embedding: embedding,
    match_count: top_k
  })

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ results: data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
```

Add the `search_documents` RPC in SQL:

```sql
create or replace function search_documents(
  query_embedding vector(1536),
  match_count int default 5
) returns table (
  id bigint,
  content text,
  similarity float
) as $$
begin
  return query
  select
    documents.id,
    documents.content,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where documents.status = 'done'
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql;
```

### 5. Environment and Deployment

Ensure:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or service role key for server‑side use) are set.
- Edge Functions are deployed via `supabase functions deploy`.
- Cron schedule is created/migrated via SQL migration.

## Usage Patterns

Typical tasks you’ll perform with this skill:

- “Add a `documents` table and embedding job queue for my RAG app on Free tier.”
- “Create a cron job that processes 10 embeddings every 5 minutes using the Free‑tier RAG skill.”
- “Review my `process-embeddings-batch` Edge Function for CPU safety on Free tier.”
- “Wire up a `retrieve-context` Edge Function for query‑time RAG using pgvector.”

## Anti‑Patterns to Avoid

- Running Transformers.js / WASM embedding models directly in Edge Functions (will exceed 2s CPU). [1][2]
- Embedding large batches (>20–30 docs) in a single Edge Function invocation on Free tier.
- Generating embeddings synchronously in the user request path for ingestion.
- Ignoring job failure handling (no retries, no `failed` status).

## Citations

[1] Supabase – Understanding Edge Function CPU limits (2s CPU, 150s wall clock on Free).  
[2] Supabase – Edge Function shutdown reasons explained (CPU time limit reached).  
[3] Supabase – Edge Function ‘wall clock time limit reached’ troubleshooting.  
[4] Supabase – Pricing & billing (500k Edge Function invocations on Free).  
[5] Supabase – Edge Functions pricing details.  
[6] Supabase – Free tier limits (DB size, project pause).  
[7] Supabase – Automatic Embeddings (triggers + queue + Edge Functions).  
[8] Supabase blog – Automatic Embeddings in Postgres.  
[9] Supabase Docs – Running AI Models in Edge Functions (Supabase.ai APIs).  