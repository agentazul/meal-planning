export type NeverUseCatalogReference = Readonly<{
  aliases: readonly string[];
  category: string;
  id: string;
  name: string;
  pluralName: string;
}>;

export type NeverUseIngredientMatch<
  Reference extends NeverUseCatalogReference = NeverUseCatalogReference,
> = Readonly<{
  excluded: readonly Reference[];
  items: readonly string[];
  unmatchedItems: readonly string[];
}>;

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/u;
const BULLET_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u;
const NEVER_USE_PHRASE_PATTERN =
  /^(?:never\s+(?:use|cook\s+with|serve)|do\s+not\s+(?:use|cook\s+with|serve)|don'?t\s+(?:use|cook\s+with|serve))\b/iu;
const INLINE_NEVER_USE_PATTERN =
  /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*)?(?:never\s+use|never\s+cook\s+with|do\s+not\s+use|don'?t\s+use)(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/iu;
const ITEM_SEPARATOR_PATTERN = /[,;/()]|\s+(?:and|or|nor)\s+/iu;

const FILLER_TOKENS = new Set([
  "a",
  "all",
  "an",
  "and",
  "any",
  "cut",
  "form",
  "include",
  "including",
  "kind",
  "never",
  "no",
  "of",
  "or",
  "other",
  "product",
  "the",
  "type",
]);

const FISH = [
  "salmon fillet",
  "cod fillet",
  "tilapia fillet",
  "tuna steak",
  "canned tuna",
  "canned salmon",
];
const SHELLFISH = ["shrimp", "crab meat", "scallop"];

const PROTEIN_FAMILY_EXTRA_MEMBERS: Readonly<
  Record<string, readonly string[]>
> = {
  beef: ["hot dog", "frozen meatball"],
  chicken: [],
  duck: [],
  fish: FISH,
  ham: [],
  lamb: [],
  pork: [
    "bacon",
    "breakfast sausage",
    "Italian sausage",
    "ham steak",
    "deli ham",
    "hot dog",
    "kielbasa",
    "frozen meatball",
  ],
  poultry: [],
  sausage: [],
  seafood: [...FISH, ...SHELLFISH],
  shellfish: SHELLFISH,
  turkey: [],
};

const PROTEIN_FAMILY_NAME_TOKENS: Readonly<Record<string, readonly string[]>> =
  {
    poultry: ["chicken", "turkey", "duck"],
  };

function normalizedToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) {
    return value.slice(0, -1);
  }
  return value;
}

function tokens(value: string): readonly string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .map(normalizedToken);
}

function containsPhrase(
  haystack: readonly string[],
  phrase: readonly string[],
): boolean {
  if (phrase.length === 0 || phrase.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - phrase.length; start += 1) {
    if (phrase.every((token, offset) => haystack[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

function cleanItem(value: string): string {
  return value
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/^[\s.:-]+|[\s.:-]+$/gu, "")
    .trim();
}

function splitItems(value: string): readonly string[] {
  return value
    .split(ITEM_SEPARATOR_PATTERN)
    .map(cleanItem)
    .filter((item) => tokens(item).some((token) => !FILLER_TOKENS.has(token)));
}

function isNeverUseHeading(text: string): boolean {
  return NEVER_USE_PHRASE_PATTERN.test(
    text.replace(/[*_`#]+/gu, "").trim(),
  );
}

export function extractNeverUseItems(markdown: string): readonly string[] {
  const lines = markdown
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const items: string[] = [];
  let sectionLevel: number | null = null;

  for (const line of lines) {
    const heading = HEADING_PATTERN.exec(line.trim());
    if (heading) {
      const level = heading[1]?.length ?? 1;
      if (sectionLevel !== null && level <= sectionLevel) {
        sectionLevel = null;
      }
      if (sectionLevel === null && isNeverUseHeading(heading[2] ?? "")) {
        sectionLevel = level;
      }
      continue;
    }

    const inline = INLINE_NEVER_USE_PATTERN.exec(line);
    if (inline) {
      items.push(...splitItems(inline[1] ?? ""));
      continue;
    }

    if (sectionLevel === null) continue;
    const bullet = BULLET_PATTERN.exec(line);
    if (bullet) items.push(...splitItems(bullet[1] ?? ""));
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = tokens(item).join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function familyMembers<Reference extends NeverUseCatalogReference>(
  family: string,
  references: readonly Reference[],
): readonly Reference[] {
  const extraNames = new Set(
    (PROTEIN_FAMILY_EXTRA_MEMBERS[family] ?? []).map((name) =>
      tokens(name).join(" "),
    ),
  );
  const nameTokens = PROTEIN_FAMILY_NAME_TOKENS[family] ?? [family];
  return references.filter((reference) => {
    const referenceTokens = tokens(reference.name);
    return (
      extraNames.has(referenceTokens.join(" ")) ||
      (reference.category === "protein" &&
        nameTokens.some((token) => referenceTokens.includes(token)))
    );
  });
}

export function matchNeverUseIngredients<
  Reference extends NeverUseCatalogReference,
>(
  markdown: string,
  references: readonly Reference[],
): NeverUseIngredientMatch<Reference> {
  const items = extractNeverUseItems(markdown);
  const excludedIds = new Set<string>();
  const unmatchedItems: string[] = [];

  for (const item of items) {
    const itemTokens = tokens(item);
    const meaningfulTokens = itemTokens.filter(
      (token) => !FILLER_TOKENS.has(token),
    );
    const family = meaningfulTokens.join(" ");
    const matches = [
      ...(Object.hasOwn(PROTEIN_FAMILY_EXTRA_MEMBERS, family)
        ? familyMembers(family, references)
        : []),
      ...references.filter((reference) =>
        [reference.name, reference.pluralName, ...reference.aliases].some(
          (phrase) => containsPhrase(itemTokens, tokens(phrase)),
        ),
      ),
    ];
    if (matches.length === 0) {
      unmatchedItems.push(item);
      continue;
    }
    for (const match of matches) excludedIds.add(match.id);
  }

  return {
    excluded: references
      .filter((reference) => excludedIds.has(reference.id))
      .sort((left, right) => left.name.localeCompare(right.name, "en-US")),
    items,
    unmatchedItems,
  };
}

export function withoutNeverUseIngredients<
  Reference extends NeverUseCatalogReference,
>(markdown: string, references: readonly Reference[]): readonly Reference[] {
  const { excluded } = matchNeverUseIngredients(markdown, references);
  if (excluded.length === 0) return references;
  const excludedIds = new Set(excluded.map((reference) => reference.id));
  return references.filter((reference) => !excludedIds.has(reference.id));
}
