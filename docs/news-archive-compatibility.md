# News archive compatibility

Article verification can now remain usable after an accepted story is archived and the application restarts. Metadata verification retains its own attribution. Unverified client claims cannot grant article verification.

The additive database proposal requires separate Owner approval before production application or activation. Existing-schema operation remains the default. There is no automatic legacy backfill or deletion. Existing stories, stored summaries, first-seen timestamps, retention and client access restrictions are preserved.

Rollback must use an evidence-aware application in archive read-only mode, preserving the added columns and committed data. A pre-fix reader can hide article-only stories again and is not a lossless rollback. While archive writes are paused, newly discovered stories are not claimed as durably archived.

Validation uses synthetic news and an isolated PostgreSQL 17 database. Native database tests exercise the application's payload through a SQL test transport; this is not live Supabase/PostgREST or Production acceptance. Production migration, merge, deployment and activation remain separately gated.

The isolated database suite is available through `test:news-evidence:postgres17`. It requires the explicitly configured local test database and creates its own temporary database. Production credentials must not be used.
