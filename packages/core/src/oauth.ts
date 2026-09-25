import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "./config.js";

/**
 * OAuth for remote MCP servers (the MCP authorization spec: protected
 * resource metadata, dynamic client registration, PKCE).
 *
 * Moka acts as a public client with a loopback redirect
 * (`http://localhost:<port>/oauth/callback`). Tokens and registered clients
 * are kept in `~/.moka/oauth.json` (mode 0600), keyed by server id and URL.
 */

interface ServerRecord {
  serverUrl: string;
  client?: { info: OAuthClientInformationMixed; redirectUrl: string };
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

export class OAuthStore {
  private cache?: Record<string, ServerRecord>;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  private async all(): Promise<Record<string, ServerRecord>> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(await readFile(this.file, "utf8"));
      } catch {
        this.cache = {};
      }
    }
    return this.cache!;
  }

  async get(serverId: string, serverUrl: string): Promise<ServerRecord> {
    const all = await this.all();
    const record = all[serverId];
    return record && record.serverUrl === serverUrl ? record : { serverUrl };
  }

  async update(serverId: string, serverUrl: string, patch: Partial<ServerRecord>): Promise<void> {
    const all = await this.all();
    all[serverId] = { ...(await this.get(serverId, serverUrl)), ...patch, serverUrl };
    await this.flush();
  }

  async clear(serverId: string): Promise<void> {
    const all = await this.all();
    delete all[serverId];
    await this.flush();
  }

  /** Find the server a callback belongs to by its `state`. */
  async byState(state: string): Promise<string | undefined> {
    const all = await this.all();
    return Object.entries(all).find(([, r]) => r.state && r.state === state)?.[0];
  }

  private flush(): Promise<void> {
    const data = JSON.stringify(this.cache ?? {}, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}

export interface OAuthSettings {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

export function oauthSettings(config: McpServerConfig): OAuthSettings | undefined {
  if (config.transport === "stdio" || config.oauth === false) return undefined;
  const hasAuthHeader = Object.keys(config.headers ?? {}).some((h) => h.toLowerCase() === "authorization");
  if (hasAuthHeader && !config.oauth) return undefined;
  return typeof config.oauth === "object" ? config.oauth : {};
}

export class MokaOAuthProvider implements OAuthClientProvider {
  /** Set when the server requires sign-in; the UI opens it. */
  authorizationUrl?: URL;

  constructor(
    private readonly store: OAuthStore,
    private readonly serverId: string,
    private readonly serverUrl: string,
    private readonly redirect: string,
    private readonly settings: OAuthSettings,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Moka",
      client_uri: "https://github.com/mokahq/mokalabs",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.settings.clientSecret ? "client_secret_post" : "none",
      ...(this.settings.scopes?.length ? { scope: this.settings.scopes.join(" ") } : {}),
    };
  }

  async state(): Promise<string> {
    const state = `${this.serverId}.${randomBytes(12).toString("hex")}`;
    await this.store.update(this.serverId, this.serverUrl, { state });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.settings.clientId) return { client_id: this.settings.clientId, ...(this.settings.clientSecret ? { client_secret: this.settings.clientSecret } : {}) };
    const record = await this.store.get(this.serverId, this.serverUrl);
    // A client registered for another port's redirect URI can't be reused.
    return record.client?.redirectUrl === this.redirect ? record.client.info : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.update(this.serverId, this.serverUrl, { client: { info, redirectUrl: this.redirect } });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.get(this.serverId, this.serverUrl)).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.update(this.serverId, this.serverUrl, { tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.update(this.serverId, this.serverUrl, { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.get(this.serverId, this.serverUrl)).codeVerifier;
    if (!verifier) throw new Error("No PKCE code verifier saved; start sign-in again");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") return this.store.clear(this.serverId);
    if (scope === "client") return this.store.update(this.serverId, this.serverUrl, { client: undefined });
    if (scope === "tokens") return this.store.update(this.serverId, this.serverUrl, { tokens: undefined });
    if (scope === "verifier") return this.store.update(this.serverId, this.serverUrl, { codeVerifier: undefined });
  }
}
