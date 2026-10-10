import { createClient } from '@supabase/supabase-js';
import { StreamingTextResponse } from 'ai';
import { CohereClient } from '@cohere-ai/client';
import { Database } from '../_lib/database.ts';

const cohere = new CohereClient({
  token: Deno.env.get('COHERE_API_KEY'),
});

// These are automatically injected
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(
      JSON.stringify({
        error: 'Missing environment variables.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const authorization = req.headers.get('Authorization');

  if (!authorization) {
    return new Response(
      JSON.stringify({ error: `No authorization header passed` }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        authorization,
      },
    },
    auth: {
      persistSession: false,
    },
  });

  const { messages, embedding } = await req.json();

  const { data: documents, error: matchError } = await supabase
    .rpc('match_document_sections', {
      embedding,
      match_threshold: 0.8,
    })
    .limit(5);

  if (matchError) {
    console.error(matchError);

    return new Response(
      JSON.stringify({
        error: 'There was an error reading your documents, please try again.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const docs = documents?.map(({ content }) => ({ text: content })) || [];

  // Cohere expects a specific chat history format
  const chatHistory = messages.slice(0, -1).map((m: any) => ({
    role: m.role === 'user' ? 'USER' : 'CHATBOT',
    message: m.content,
  }));

  const userMessage = messages[messages.length - 1].content;

  try {
    const response = await cohere.chatStream({
      model: 'command-r-plus-08-2024',
      message: userMessage,
      documents: docs,
      chatHistory: chatHistory,
      preamble: `You're an AI assistant who answers questions about documents.
You're a chat bot, so keep your replies succinct.
You're only allowed to use the documents provided to answer the question.
If the question isn't related to these documents, or if the information isn't available in the documents, say:
"Sorry, I couldn't find any information on that."
Do not go off topic.`,
    });

    // Create a ReadableStream to convert Cohere's event stream to raw text chunks for the frontend
    const stream = new ReadableStream({
      async start(controller) {
        for await (const event of response) {
          if (event.eventType === 'text-generation') {
            controller.enqueue(new TextEncoder().encode(event.text));
          }
        }
        controller.close();
      },
    });

    return new StreamingTextResponse(stream, { headers: corsHeaders });
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: 'An error occurred while generating the response.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
});
