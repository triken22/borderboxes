// server/loot.ts
export type Gun = {
  archetype: 'pistol' | 'smg' | 'rifle';
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  dps: number;
  mag: number;
  reloadMs: number;
  fireRate: number; // shots per second
  accuracy: number; // 0-1, affects spread
  range: number; // max effective range
  seed: string;
};

export function rollGun(seed: string): Gun {
  const rnd = mulberry32(hash(seed));
  const archetypes: Gun['archetype'][] = ['pistol', 'smg', 'rifle'];
  const rarityTable = ['common', 'common', 'rare', 'rare', 'epic', 'legendary'] as const;

  const archetype = archetypes[Math.floor(rnd() * archetypes.length)];
  const rarity = rarityTable[Math.floor(rnd() * rarityTable.length)];

  // Base stats by archetype
  const base = {
    pistol: { dps: 80, mag: 12, reload: 1100, fireRate: 3, accuracy: 0.85, range: 25 },
    smg: { dps: 140, mag: 30, reload: 1500, fireRate: 10, accuracy: 0.7, range: 20 },
    rifle: { dps: 200, mag: 24, reload: 1800, fireRate: 2, accuracy: 0.95, range: 40 }
  }[archetype];

  // Rarity multipliers
  const mult = {
    common: 1,
    rare: 1.15,
    epic: 1.35,
    legendary: 1.6
  }[rarity];

  const jitter = (n: number, p: number) => n * (1 + (rnd() * 2 - 1) * p);

  return {
    archetype,
    rarity,
    seed,
    dps: Math.round(jitter(base.dps * mult, 0.12)),
    mag: Math.max(6, Math.round(jitter(base.mag * mult, 0.15))),
    reloadMs: Math.round(jitter(base.reload, 0.12)),
    fireRate: jitter(base.fireRate * (rarity === 'legendary' ? 1.3 : rarity === 'epic' ? 1.15 : 1), 0.1),
    accuracy: Math.min(1, base.accuracy + (rarity === 'legendary' ? 0.1 : rarity === 'epic' ? 0.05 : 0)),
    range: base.range * (rarity === 'legendary' ? 1.3 : rarity === 'epic' ? 1.15 : 1)
  };
}

// Hash function for seed generation
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Seeded random number generator
function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}