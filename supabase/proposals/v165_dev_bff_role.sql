-- NOT APPLIED. Additional Dev-only role/grant approval required.
-- Password remains NULL until provisioned through an approved secret channel.
-- Does not change table grants, RLS, schema or the existing revocation guard.
begin;
create role setscope_v165_dev_bff login inherit nosuperuser nocreatedb
  nocreaterole noreplication nobypassrls connection limit 2 password null;
grant setscope_session_store to setscope_v165_dev_bff with inherit true;
grant setscope_session_store to setscope_v165_dev_bff with set false;
commit;
