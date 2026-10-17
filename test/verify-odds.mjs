// Vérifie la formule de probabilité par carte contre les taux officiels de /api/packs.
const BASE = 'https://kyara.games';
const RARITIES = ['C', 'U', 'R', 'E', 'L', 'M'];

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function chance(pack, rarity, poolCount, poolSet, cardId) {
  if (poolSet && !poolSet.has(String(cardId))) return 0;
  // Dénominateur officiel du site quand il est publié (source de perCardPct).
  const officialPool = Number(pack.rates?.cardsByRarity?.[rarity]);
  const denom = Number.isFinite(officialPool) && officialPool > 0 ? officialPool : poolCount;
  const featuredIds = (pack.rateUp?.characterIds ?? []).map(String);
  const featuredRarities = (pack.rateUp?.rarities ?? []).map(String);
  const featured = featuredIds.includes(String(cardId)) && featuredRarities.includes(rarity);
  const share = featuredRarities.length ? Math.min(1, Math.max(0, Number(pack.rateUp?.share) ?? 0)) : 0;
  const featuredCount = featured
    ? Math.max(1, featuredIds.filter((id) => String(id) !== '' ).length)
    : 0;

  const expected = (slots) => {
    let total = 0;
    for (const slot of slots ?? []) {
      const pct = Number(slot?.pct?.[rarity]);
      if (Number.isFinite(pct) && pct > 0) total += pct / 100;
    }
    return total;
  };

  const one = (slots) => {
    const n = expected(slots);
    if (!n) return 0;
    if (!featuredRarities.includes(rarity)) return n / denom;
    const general = ((1 - share) * n) / denom;
    const feat = featured ? (share * n) / featuredCount : 0;
    return general + feat;
  };

  const normal = one(pack.rates?.slots);
  const goldenSlots = pack.goldenEligible ? pack.rates?.golden?.slots : null;
  const g = goldenSlots ? 1 / 10 : 0;
  const golden = goldenSlots ? one(goldenSlots) : normal;
  return { blended: normal * (1 - g) + golden * g, normal, golden, g };
}

const packs = await getJson('/api/packs');
const chars = await getJson('/api/characters');
const byRarity = new Map(RARITIES.map((r) => [r, chars.filter((c) => c.rarity === r).map((c) => String(c.id))]));

let checks = 0;
let bad = 0;

for (const pack of packs) {
  if (pack.rateUp) continue; // sans vedette : comparable aux taux officiels
  const ids = await getJson(`/api/packs/${pack.id}/characters`);
  const poolSet = new Set(ids.map(String));
  const counts = {};
  for (const id of poolSet) {
    const c = chars.find((x) => String(x.id) === id);
    if (c) counts[c.rarity] = (counts[c.rarity] ?? 0) + 1;
  }

  for (const rarity of RARITIES) {
    const official = pack.rates?.perBooster?.[rarity]?.perCardPct;
    if (official == null) continue;
    const cardId = byRarity.get(rarity).find((id) => poolSet.has(id));
    if (!cardId) continue;

    const res = chance(pack, rarity, counts[rarity], poolSet, cardId);
    const pctNormal = res.normal * 100;
    const pctBlend = res.blended * 100;
    checks += 1;
    const diff = Math.abs(pctNormal - official);
    const tolerance = Math.max(0.0004, official * 0.02);
    if (diff > tolerance) {
      bad += 1;
      console.log(
        `MISMATCH ${pack.id} ${rarity}: hors-golden=${pctNormal.toFixed(6)} officiel=${official.toFixed(6)} (avec golden=${pctBlend.toFixed(6)})`
      );
    }
  }
}

console.log(`\nComparaisons: ${checks} · écarts: ${bad}`);

// Cas vedette : bannière JJK
const banner = packs.find((p) => p.rateUp);
if (banner) {
  const ids = await getJson(`/api/packs/${banner.id}/characters`);
  const poolSet = new Set(ids.map(String));
  const counts = {};
  for (const id of poolSet) {
    const c = chars.find((x) => String(x.id) === id);
    if (c) counts[c.rarity] = (counts[c.rarity] ?? 0) + 1;
  }
  const featIds = banner.rateUp.characterIds.map(String);
  const fid = featIds[0];
  const card = chars.find((c) => String(c.id) === fid);
  const featuredRes = chance(banner, card.rarity, counts[card.rarity], poolSet, fid);
  const normalId = byRarity.get(card.rarity).find((id) => poolSet.has(id) && !featIds.includes(id));
  const normalRes = chance(banner, card.rarity, counts[card.rarity], poolSet, normalId);
  console.log(
    `\n${banner.name} (${banner.rateUp.rarities.join('/')} share=${banner.rateUp.share}, ${featIds.length} vedettes)`
  );
  console.log(`  ${card.name} (vedette, ${card.rarity}) : ${(featuredRes.normal * 100).toFixed(4)} % hors golden, ${(featuredRes.blended * 100).toFixed(4)} % golden inclus`);
  console.log(`  carte ${card.rarity} normale            : ${(normalRes.normal * 100).toFixed(4)} % hors golden`);
  console.log(`  officiel perCardPct ${card.rarity}      : ${banner.rates.perBooster[card.rarity].perCardPct} % (sans vedette)`);
}
