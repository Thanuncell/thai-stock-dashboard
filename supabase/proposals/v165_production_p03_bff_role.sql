-- P03 Production proposal ONLY. NOT APPLIED. Owner approval required.
-- No password in SQL/history. Provision independently through approved storage.
-- Two connections/process; limit includes old/new process overlap and probes.
begin;
create role setscope_v165_bff login inherit nosuperuser nocreatedb nocreaterole
  noreplication nobypassrls connection limit 8 password null;
grant setscope_session_store to setscope_v165_bff with inherit true;
grant setscope_session_store to setscope_v165_bff with set false;
commit;
