---
"@mokalabs/sandbox": patch
---

`@mokalabs/sandbox` now ships as a single self-contained package with zero runtime dependencies. Everything (including `@mokalabs/core`) is bundled at build time from the repo's 14-day-vetted lockfile, so `npx @mokalabs/sandbox` installs exactly one package — nothing floats to freshly published versions, and it works behind curated/quarantined registries.
