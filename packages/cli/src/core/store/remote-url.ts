import { GliaError } from "../output/errors.ts";

/**
 * The declared Store remote must be credential-free; credentials never
 * enter the declaration or any Glia state. Authentication belongs
 * entirely to Git. Validation is offline and never touches the network.
 *
 * - http(s): any userinfo is rejected — a bare user name only exists to
 *   feed an interactive credential prompt;
 * - ssh:// and scp-style: a user name is transport identity and allowed,
 *   a password is not;
 * - file:// URLs and absolute paths are accepted.
 */
export function validateStoreRemoteUrl(url: string): void {
  if (url.length === 0) {
    throw new GliaError("USAGE", "the store remote URL must not be empty");
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase() ?? null;
  if (scheme !== null) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GliaError("USAGE", `the store remote URL is not a valid URL: ${url}`);
    }
    if (scheme === "http" || scheme === "https") {
      if (parsed.username !== "" || parsed.password !== "") {
        throw new GliaError(
          "USAGE",
          "an http(s) store remote must not carry userinfo; even a bare user name only exists to feed a credential prompt — configure a Git credential helper instead",
          { url: redact(url) },
        );
      }
      return;
    }
    if (parsed.password !== "") {
      throw new GliaError(
        "USAGE",
        "the store remote URL must not carry a password; credentials belong to Git (SSH agents, credential helpers), never to the declaration",
        { url: redact(url) },
      );
    }
    return;
  }

  if (url.startsWith("/")) return; // absolute path

  // scp-style: [user@]host:path — a user name is allowed, a password is not.
  const scp = /^(?:([^@/]+)@)?[^:/]+:/.exec(url);
  if (scp) {
    const userinfo = scp[1];
    if (userinfo !== undefined && userinfo.includes(":")) {
      throw new GliaError(
        "USAGE",
        "the store remote URL must not carry a password; credentials belong to Git (SSH agents, credential helpers), never to the declaration",
        { url: redact(url) },
      );
    }
    return;
  }

  throw new GliaError(
    "USAGE",
    `the store remote must be a Git URL (ssh://, http(s)://, file://, scp-style) or an absolute path, got: ${url}`,
  );
}

/** Details never echo a possible credential back verbatim. */
function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//<userinfo>@").replace(/^[^@/]+@/, "<userinfo>@");
}
