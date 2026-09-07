-- Migration number: 0003 	 2026-09-07T14:41:01.653Z
alter table messages add column body_text text;
alter table messages add column body_html text;
