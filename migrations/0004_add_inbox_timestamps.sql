-- Migration number: 0004 	 2026-09-08T00:00:00.000Z
alter table inboxes add column created_at integer not null default 0;
alter table inboxes add column expires_at integer not null default 0;

-- rows predating these columns get the same 7 day window as new ones
update inboxes set created_at = unixepoch();
update inboxes set expires_at = created_at + 604800;
