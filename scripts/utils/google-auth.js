import { SignJWT, importPKCS8 } from "jose";

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();

const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Get a Google OAuth2 access token via service account JWT.
 * Tokens are cached per scope until 5 minutes before expiry.
 *
 * @param {string} email  Service account email
 * @param {string} privateKey  PEM-encoded RSA private key
 * @param {string} scope  OAuth2 scope URL
 * @returns {Promise<string>} Access token
 */
export async function getGoogleAccessToken(email, privateKey, scope) {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + BUFFER_MS) {
    return cached.token;
  }

  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256");

  const jwt = await new SignJWT({
    iss: email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  }

  tokenCache.set(scope, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });

  return data.access_token;
}
