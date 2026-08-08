const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TRUSTED_FETCH_SITES = new Set(["same-origin", "none"]);

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isTrustedRequest(
  request: Request,
  trustedApplicationUrl: string,
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return true;
  }

  const trustedOrigin = parseOrigin(trustedApplicationUrl);
  if (!trustedOrigin) {
    return false;
  }

  const originHeader = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase() ?? null;

  if (originHeader && parseOrigin(originHeader) !== trustedOrigin) {
    return false;
  }

  if (fetchSite && !TRUSTED_FETCH_SITES.has(fetchSite)) {
    return false;
  }

  return Boolean(originHeader || fetchSite);
}

export function rejectUntrustedRequest(
  request: Request,
  trustedApplicationUrl: string,
): Response | null {
  if (isTrustedRequest(request, trustedApplicationUrl)) {
    return null;
  }

  return new Response("Forbidden.", {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
