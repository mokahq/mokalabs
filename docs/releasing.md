# Releasing

Releases are fully automated with [Changesets](https://github.com/changesets/changesets) and GitHub Actions.

## One-time setup

1. **npm**: create the `mokalabs` org on npmjs.com (for `@mokalabs/*`), and make sure the unscoped `create-moka` name is yours.
2. Create an npm **automation** token with publish rights and add it as the `NPM_TOKEN` repository secret.
3. In the repo settings, go to Actions → General → Workflow permissions and enable **Read and write** plus **Allow GitHub Actions to create and approve pull requests**.
4. GHCR needs no setup: the workflow pushes `ghcr.io/<owner>/moka` with `GITHUB_TOKEN`. After the first push, set the package's visibility to **Public** under Packages.
5. **Docs**: Settings → Pages → Source: **GitHub Actions**. The Docs workflow publishes `apps/docs` on every push to `main` that touches it. For a custom domain set the repository variables `DOCS_SITE` (e.g. `https://docs.mokalabs.dev`) and `DOCS_BASE` (`/`).
6. If the repo is not `mokalabs/moka`, update `repository` in each `packages/*/package.json`, `.changeset/config.json`, and the image name in the README and Dockerfile labels.

## Day to day

```bash
pnpm changeset          # describe your change, choose patch/minor/major
git commit -am "feat: …" && git push
```

When changes land on `main`, the **Release** workflow:

1. Opens or updates a **"chore: version packages"** PR that bumps versions and writes the CHANGELOGs.
2. When you merge that PR, it:
   - publishes `@mokalabs/core`, `@mokalabs/sandbox` and `create-moka` to npm with provenance,
   - creates git tags and **GitHub Releases** with the changelog, and
   - builds and pushes the multi-arch Docker image (`latest`, `X.Y.Z`, `X.Y`) to GHCR.

## First release

The packages start at `0.1.0`. `changeset publish` publishes any version that isn't on npm yet, so the very first push to `main` (with `NPM_TOKEN` set) publishes `0.1.0` and creates the `v0.1.0` releases. No changeset is needed for that.

## Manual release (fallback)

```bash
pnpm install && pnpm build && pnpm test
pnpm changeset version     # if there are pending changesets
pnpm changeset publish     # uses your local npm login
git push --follow-tags
```
