import tls from "node:tls";

/**
 * How Moka trusts the operating system's certificate store (macOS keychain,
 * Windows certificate store, the Linux CA bundle), the way a browser does. On
 * company networks the gateway, or a proxy that inspects TLS, often presents a
 * certificate signed by an internal CA that is installed in the OS store but
 * that Node doesn't trust by default ("self-signed certificate in certificate
 * chain").
 *
 * - `loaded`: added to Node's default CAs in this process (Node 22.19+ / 24.5+).
 * - `flag`: this process was started with --use-system-ca.
 * - `relaunch`: Node only has the --use-system-ca flag; restart with it.
 * - `unsupported`: this Node can't read the OS store; NODE_EXTRA_CA_CERTS still works.
 * - `off`: turned off with --no-system-ca or MOKA_SYSTEM_CA=0.
 */
export type SystemCaMode = "loaded" | "flag" | "relaunch" | "unsupported" | "off";

type TlsWithCa = typeof tls & {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

export function trustSystemCertificates(env: NodeJS.ProcessEnv = process.env, enabled = true): { mode: SystemCaMode; count?: number } {
  if (!enabled || env.MOKA_SYSTEM_CA === "0") return { mode: "off" };
  if (process.execArgv.includes("--use-system-ca")) return { mode: "flag" };
  const t = tls as TlsWithCa;
  if (typeof t.getCACertificates === "function" && typeof t.setDefaultCACertificates === "function") {
    try {
      const system = t.getCACertificates("system");
      // "default" already includes Node's bundled CAs and NODE_EXTRA_CA_CERTS.
      t.setDefaultCACertificates([...new Set([...t.getCACertificates("default"), ...system])]);
      // MCP servers Moka starts (npx …) are Node programs too: let them trust the same store.
      env.NODE_USE_SYSTEM_CA = "1";
      return { mode: "loaded", count: system.length };
    } catch {
      // fall through to the flag
    }
  }
  return process.allowedNodeEnvironmentFlags.has("--use-system-ca") ? { mode: "relaunch" } : { mode: "unsupported" };
}
