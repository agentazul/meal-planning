import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SIGNING_CONTEXT = "done-for-you-kitchen:generated-recipe-draft:v1\0";
const CATALOG_FINGERPRINT_CONTEXT =
  "done-for-you-kitchen:generated-recipe-catalog:v1\0";

type CatalogFingerprintEntry = Readonly<{
  baseUnit: string;
  catalogKey: string;
  category: string;
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  id: string;
  name: string;
  requiredMinimumInternalTemperatureF: number | null;
}>;

export function fingerprintGeneratedRecipeCatalog(
  catalog: readonly CatalogFingerprintEntry[],
): string {
  const stableCatalog = [...catalog]
    .sort((left, right) => left.catalogKey.localeCompare(right.catalogKey))
    .map((entry) => ({
      baseUnit: entry.baseUnit,
      catalogKey: entry.catalogKey,
      category: entry.category,
      densityGramsPerMl: entry.densityGramsPerMl,
      gramsPerCount: entry.gramsPerCount,
      id: entry.id,
      name: entry.name,
      requiredMinimumInternalTemperatureF:
        entry.requiredMinimumInternalTemperatureF,
    }));

  return createHash("sha256")
    .update(CATALOG_FINGERPRINT_CONTEXT)
    .update(JSON.stringify(stableCatalog))
    .digest("base64url");
}

function calculateSignature(envelope: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(SIGNING_CONTEXT)
    .update(envelope)
    .digest();
}

export function signGeneratedDraft(
  value: unknown,
  secret: string,
): Readonly<{ envelope: string; signature: string }> {
  const envelope = JSON.stringify(value);
  const signature = calculateSignature(envelope, secret).toString("base64url");
  return { envelope, signature };
}

export function hasValidGeneratedDraftSignature(
  envelope: string,
  signature: string,
  secret: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return false;
  }

  const expected = calculateSignature(envelope, secret);
  const supplied = Buffer.from(signature, "base64url");

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
