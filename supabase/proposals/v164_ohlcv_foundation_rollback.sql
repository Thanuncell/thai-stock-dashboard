-- Review/local-test rollback only. Export accepted snapshots before an approved production removal.
begin;
drop schema screener_private cascade;
commit;
