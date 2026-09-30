// Modified by ZCode Feiyu contributors (2026).
export const PROACTIVE_EVENTS_SCHEMA = `
  create table if not exists proactive_event (event_id text primary key, workspace_key text not null,
    source_session_id text not null, source_id text not null, kind text not null, depth integer not null, created_at integer not null);
  create table if not exists proactive_trigger (trigger_id text primary key, event_id text not null,
    workspace_key text not null, source_session_id text not null, target_session_id text not null,
    command_id text not null unique, prompt text not null, generation integer not null, depth integer not null,
    state text not null, attempts integer not null default 0, retry_at integer not null default 0,
    owner_id text, lease_until integer, error text, updated_at integer not null);
  create index if not exists proactive_trigger_pending on proactive_trigger(workspace_key, state, retry_at);
`;
