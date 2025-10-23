/**
 * @module version
 *
 * Utility helpers for determining a CLI or module's semantic version (SemVer)
 * at runtime, based on `import.meta.url`.
 *
 * These functions are designed to make your Deno CLIs and libraries display
 * a meaningful version string in their `--help` text, whether they’re running
 * from a local filesystem checkout or a remote CDN/GitHub URL.
 *
 * ---
 *
 * ## computeSemVer (async)
 *
 * ```ts
 * const version = await computeSemVer();
 * console.log(version); // e.g. "v1.4.2" or "v1.4.2-local"
 * ```
 *
 * - **When to use:**
 *   Use this when your CLI or module may run locally *and* you want to
 *   dynamically fetch the latest release tag from GitHub (via the GitHub API)
 *   when running from a local file (`file:` URL).
 *   This provides the most accurate, up-to-date version number without manual
 *   intervention, but requires network access and async/await.
 *
 * - **Behavior:**
 *   - If running from `file:` and `GITHUB_REPOSITORY` is set
 *     (e.g. `"owner/repo"`), fetches the latest GitHub tag and appends `-local`.
 *   - If running from remote URLs (deno.land, jsr.io, raw.githubusercontent.com,
 *     cdn.jsdelivr.net), parses the version or branch ref directly.
 *   - If detection fails, falls back to `"v0.0.0-local"` or `"v0.0.0-remote"`.
 *
 * ---
 *
 * ## computeSemVerSync (sync)
 *
 * ```ts
 * const version = computeSemVerSync();
 * console.log(version); // e.g. "v1.4.2-local"
 * ```
 *
 * - **When to use:**
 *   Use this for CLIs that must initialize synchronously (e.g. inside
 *   `cliffy.Command().version()` or when async startup is undesirable).
 *   It does not call external APIs and executes instantly.
 *
 * - **Behavior:**
 *   - For `file:` URLs, attempts to read the latest tag from `.git/refs/tags/`
 *     or from the environment variable `GITHUB_LATEST_TAG`, and appends `-local`.
 *   - For remote URLs, extracts the version/ref as in `computeSemVer()`.
 *   - If detection fails, returns `"v0.0.0-local"` or `"v0.0.0-remote"`.
 *
 * ---
 *
 * ## Example usage
 *
 * ```ts
 * import { computeSemVer, computeSemVerSync } from "./version.ts";
 *
 * // Async CLI banner
 * const version = await computeSemVer();
 * console.log(`spry CLI ${version}`);
 *
 * // Synchronous variant for lightweight scripts
 * const versionSync = computeSemVerSync();
 * console.log(`spry CLI ${versionSync}`);
 * ```
 *
 * ---
 *
 * Both variants guarantee a valid SemVer string (prefixed with "v") and
 * will never throw unhandled exceptions. They’re ideal for embedding version
 * information into CLI help text, logs, diagnostics, or analytics.
 */

/**
 * Compute a SemVer-ish version string for CLI help.
 *
 * - If running from file:, fetch the latest GitHub tag (if possible) and append "-local".
 * - If remote (GitHub, deno.land, jsr.io, jsDelivr), extract the version/ref.
 * - Always returns a valid version string like "v1.2.3-local" or "v0.0.0-remote".
 */
export async function computeSemVer(
  importUrl: string = import.meta.url,
): Promise<string> {
  const normalize = (v: string) => (v.startsWith("v") ? v : `v${v}`);
  const semverRe = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  try {
    const url = new URL(importUrl);

    // 🧩 Handle local file URLs
    if (url.protocol === "file:") {
      // Try to infer repo from a nearby .git or environment var
      const repoUrl = Deno.env.get("GITHUB_REPOSITORY") // e.g. "owner/repo"
        ? `https://api.github.com/repos/${
          Deno.env.get("GITHUB_REPOSITORY")
        }/tags`
        : undefined;

      if (repoUrl) {
        try {
          const res = await fetch(repoUrl, {
            headers: { Accept: "application/vnd.github+json" },
          });
          if (res.ok) {
            const tags = await res.json();
            if (Array.isArray(tags) && tags.length > 0) {
              const tagName = tags[0].name;
              if (semverRe.test(tagName)) return `${normalize(tagName)}-local`;
            }
          }
        } catch {
          // ignore and fall through
        }
      }
      return "v0.0.0-local";
    }

    // 🧩 Handle remote URLs
    const host = url.hostname;
    const path = url.pathname;

    const extractAtVersion = (s: string) => {
      const m = s.match(
        /@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/,
      );
      return m ? normalize(m[1]) : null;
    };

    if (host === "deno.land" || host === "jsr.io") {
      return extractAtVersion(path) ?? "v0.0.0-remote";
    }

    if (host === "raw.githubusercontent.com") {
      const [, _owner, _repo, ref] = path.split("/");
      if (ref && semverRe.test(ref)) return normalize(ref);
      return ref ? `v0.0.0-branch-${ref}` : "v0.0.0-remote";
    }

    if (host === "cdn.jsdelivr.net" && path.startsWith("/gh/")) {
      const afterGh = path.slice("/gh/".length);
      const atIdx = afterGh.indexOf("@");
      const slashIdx = afterGh.indexOf("/", Math.max(atIdx, 0));
      const ref = atIdx >= 0
        ? afterGh.slice(atIdx + 1, slashIdx >= 0 ? slashIdx : undefined)
        : "";
      if (ref && semverRe.test(ref)) return normalize(ref);
      return ref ? `v0.0.0-branch-${ref}` : "v0.0.0-remote";
    }

    const generic = extractAtVersion(path);
    if (generic) return generic;

    return "v0.0.0-remote";
  } catch {
    return "v0.0.0-unknown";
  }
}

/**
 * Compute a SemVer-like version string synchronously.
 * - For file: URLs, try to read .git/refs/tags or use env GITHUB_LATEST_TAG.
 * - For remote URLs, extract @vX.Y.Z or ref.
 * - Always returns something like "v1.2.3" or "v0.0.0-local".
 */
export function computeSemVerSync(importUrl: string = import.meta.url): string {
  const normalize = (v: string) => (v.startsWith("v") ? v : `v${v}`);
  const semverRe = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  try {
    const url = new URL(importUrl);

    // --- Local mode ---
    if (url.protocol === "file:") {
      // Try environment variable first (can be set by build pipeline)
      const envTag = Deno.env.get("GITHUB_LATEST_TAG");
      if (envTag && semverRe.test(envTag)) return `${normalize(envTag)}-local`;

      // Try reading from .git/refs/tags if available
      try {
        const cwd = Deno.cwd();
        for (const entry of Deno.readDirSync(`${cwd}/.git/refs/tags`)) {
          const tagName = entry.name;
          if (semverRe.test(tagName)) return `${normalize(tagName)}-local`;
        }
      } catch {
        // ignore if .git not present
      }

      return "v0.0.0-local";
    }

    // --- Remote mode ---
    const host = url.hostname;
    const path = url.pathname;

    const extractAtVersion = (s: string) => {
      const m = s.match(
        /@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/,
      );
      return m ? normalize(m[1]) : null;
    };

    if (host === "deno.land" || host === "jsr.io") {
      return extractAtVersion(path) ?? "v0.0.0-remote";
    }

    if (host === "raw.githubusercontent.com") {
      const [, _owner, _repo, ref] = path.split("/");
      if (ref && semverRe.test(ref)) return normalize(ref);
      return ref ? `v0.0.0-branch-${ref}` : "v0.0.0-remote";
    }

    if (host === "cdn.jsdelivr.net" && path.startsWith("/gh/")) {
      const afterGh = path.slice("/gh/".length);
      const atIdx = afterGh.indexOf("@");
      const slashIdx = afterGh.indexOf("/", Math.max(atIdx, 0));
      const ref = atIdx >= 0
        ? afterGh.slice(atIdx + 1, slashIdx >= 0 ? slashIdx : undefined)
        : "";
      if (ref && semverRe.test(ref)) return normalize(ref);
      return ref ? `v0.0.0-branch-${ref}` : "v0.0.0-remote";
    }

    const generic = extractAtVersion(path);
    if (generic) return generic;

    return "v0.0.0-remote";
  } catch {
    return "v0.0.0-unknown";
  }
}
