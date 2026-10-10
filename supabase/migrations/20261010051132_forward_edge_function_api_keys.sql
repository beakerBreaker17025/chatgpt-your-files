create or replace function private.handle_storage_update()
returns trigger
language plpgsql
as $$
declare
  document_id bigint;
  result bigint;
  request_headers jsonb = coalesce(
    current_setting('request.headers', true)::jsonb,
    '{}'::jsonb
  );
begin
  insert into documents (name, storage_object_id, created_by)
    values (new.path_tokens[2], new.id, new.owner)
    returning id into document_id;

  select
    net.http_post(
      url := supabase_url() || '/functions/v1/process',
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', request_headers->>'authorization',
        'apikey', request_headers->>'apikey'
      )),
      body := jsonb_build_object(
        'document_id', document_id
      )
    )
  into result;

  return null;
end;
$$;


create or replace function private.embed()
returns trigger
language plpgsql
as $$
declare
  content_column text = TG_ARGV[0];
  embedding_column text = TG_ARGV[1];
  batch_size int = case when array_length(TG_ARGV, 1) >= 3 then TG_ARGV[2]::int else 5 end;
  timeout_milliseconds int = case when array_length(TG_ARGV, 1) >= 4 then TG_ARGV[3]::int else 5 * 60 * 1000 end;
  batch_count int = ceiling((select count(*) from inserted) / batch_size::float);
  request_headers jsonb = coalesce(
    current_setting('request.headers', true)::jsonb,
    '{}'::jsonb
  );
begin
  for i in 0 .. (batch_count-1) loop
    perform net.http_post(
      url := supabase_url() || '/functions/v1/embed',
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', request_headers->>'authorization',
        'apikey', request_headers->>'apikey'
      )),
      body := jsonb_build_object(
        'ids', (select json_agg(ds.id) from (select id from inserted limit batch_size offset i*batch_size) ds),
        'table', TG_TABLE_NAME,
        'contentColumn', content_column,
        'embeddingColumn', embedding_column
      ),
      timeout_milliseconds := timeout_milliseconds
    );
  end loop;

  return null;
end;
$$;
