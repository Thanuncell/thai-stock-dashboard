# News impact analysis — Phase 1

An optional integration for the existing news view. Users submit an article URL
or text and receive a summary and potentially affected Thai stocks with reasons
and source evidence. Existing authentication and Coverage validation are reused.

The normal application bootstrap keeps this feature disabled. Weekly quota,
database cache and durable replay remain deferred. Production activation and
authenticated live acceptance require a separate release review.

## Offline verification

Use Node.js 24+ for this module. The existing application runtime is unchanged.
Install the repository's existing dependencies, then the pinned module dependencies:

```sh
npm ci --ignore-scripts
pnpm --dir offline-news-impact install --frozen-lockfile --ignore-scripts
pnpm --dir offline-news-impact test
pnpm --dir offline-news-impact exec playwright install chromium
pnpm --dir offline-news-impact browser
```

Use the pnpm version in package.json. Browser tests use bundled Chromium on Linux
or installed Chrome on Windows; SETSCOPE_BROWSER_EXECUTABLE can override it.
Tests use mocked provider/authentication transports and synthetic news. No real
API key is required. Test identity/name pairs come from existing reviewed Coverage;
their operational metadata is synthetic and is not a live registry snapshot.

Provider live tests and production authentication are outside this test suite.
The normal bootstrap also provides the rollback path by omitting the optional
module. See THIRD_PARTY.md for Reader attribution and limitations.
