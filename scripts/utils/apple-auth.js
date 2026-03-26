import { SignJWT, importPKCS8 } from "jose";

/**
 * Generate an App Store Connect JWT (ES256).
 * Tokens are valid for up to 20 minutes (Apple maximum).
 *
 * @param {string} issuerId  Issuer ID from App Store Connect
 * @param {string} keyId     10-character Key ID
 * @param {string} privateKey PEM-encoded EC private key (.p8 contents)
 * @returns {Promise<string>} JWT bearer token
 */
export async function generateAppStoreToken(issuerId, keyId, privateKey) {
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "ES256");

  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
    .setIssuer(issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt()
    .setExpirationTime("20m")
    .sign(key);
}
