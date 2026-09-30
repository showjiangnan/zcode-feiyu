// Modified by ZCode Feiyu contributors (2026).
export const TASK_RESOURCE_SCHEMA = `
  create table if not exists task_resource_budget (root_session_id text primary key, started_at integer not null,
    policy_json text not null, generation integer not null default 1, policy_revision integer not null default 0);
  create table if not exists task_resource_request (request_id text primary key, root_session_id text not null,
    reserved_tokens integer not null, actual_tokens integer, state text not null, created_at integer not null,
    settled_at integer, generation integer not null default 1, owner_pid integer);
  create index if not exists task_resource_root on task_resource_request(root_session_id);
`;
