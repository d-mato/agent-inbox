-- Migration number: 0001 	 2026-09-07T00:00:00.000Z
create table inboxes (
  local_part text primary key
);

create table messages (
  id            integer primary key,
  local_part    text not null references inboxes(local_part) on delete cascade,
  envelope_from text not null,
  subject       text,
  received_at   integer not null
);
