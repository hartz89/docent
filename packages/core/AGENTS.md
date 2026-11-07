# packages/core

The framework-free engine. Plain TypeScript, no runtime dependencies, no framework imports.

- **The domain model is specified in [`SPEC.md`](SPEC.md).** It numbers each rule (D3, C5, B4…), and tests cite those numbers in their names.
- **Change the spec in the same PR as the code.** Add or change the rule first, then the code and its test. `src/spec.test.ts` fails if an invariant has no test citing it, or a test cites one that doesn't exist.
- **Make illegal states unrepresentable.** Use discriminated unions and branded ids, not optional fields standing in for states. Rules the types enforce are marked "(type)" in the spec and checked by `@ts-expect-error` lines in `src/types.test.ts`.
- **Run the core tests:** `pnpm exec vitest run --project core`. `pnpm verify` runs them too. Shared fast-check generators live in `src/arbitraries.ts`.
- Node runs the `.ts` files directly, so only erasable TypeScript syntax is allowed, and imports end in `.ts`.
