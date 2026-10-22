<!-- The title is a Conventional Commit: feat(graders): …, fix(harness): …, docs: … (it becomes the changelog entry). -->

## What and why

<!-- What changes, and the problem it solves. Link the issue: Closes #… -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, the Developer Certificate of Origin)
- [ ] `npm run lint`, `npm run typecheck`, `npm test` and `npm run validate:examples` pass locally
- [ ] Tests cover the change, and none of them calls a real model or needs an API key
- [ ] Docs updated (README, `docs/`); runnable samples still pass the doc-test
- [ ] A change to a file format or the public API was discussed in an issue first, and a breaking change is marked with `!` in the title
- [ ] Only synthetic data in tests, examples and this description
