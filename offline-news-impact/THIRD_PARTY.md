# Third-party attribution

- Jina Reader OSS 0.5.0, commit 1574bfd380d249c86c82db4dace0d9c8fe17e2b1, https://github.com/jina-ai/reader/tree/1574bfd380d249c86c82db4dace0d9c8fe17e2b1 — Apache-2.0, Copyright Jina AI Limited. The original src/services/jsdom.ts is retained in vendor/jsdom.upstream.ts with vendor/JINA-LICENSE. This distribution is a modified HTML extraction subset: build-reader.cjs selects actualNarrowSnapshot and transpiles it into vendor/jina-html.cjs with a small DOM adapter. Service/worker wiring is omitted and the generated class is renamed. It is not the complete upstream runtime or a hosted Jina service.
- @mozilla/readability 0.6.0 — Apache-2.0.
- linkedom 0.18.12 — ISC.
- Development/test tools: TypeScript 5.9.3 — Apache-2.0; Playwright 1.56.1 — Apache-2.0; pg 8.16.3 — MIT.

Pinned dependency resolution is in pnpm-lock.yaml. License notices for dependencies are retained in vendor/licenses/. This integration supports HTML extraction; it does not bundle upstream browser, PDF, office or image acquisition pipelines. Test news is synthetic. No third-party news article is redistributed.
