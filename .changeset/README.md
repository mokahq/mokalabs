# Changesets

Every user-facing change needs a changeset:

```bash
pnpm changeset
```

Pick the bump (patch / minor / major) and write one line for the changelog. All Moka packages
(`@mokalabs/core`, `@mokalabs/sandbox`, `create-moka`) are versioned together.

On merge to `main`, the Release workflow opens a "Version packages" PR. Merging that PR publishes
to npm, creates GitHub Releases, and pushes the Docker image to GHCR.
