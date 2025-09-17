// Audio configuration with R2 bucket URLs
// All audio files are served from Cloudflare R2 for global CDN performance

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:8787' : 'https://borderboxes-api.highfive.workers.dev');

const AUDIO_BASE = `${API_BASE}/audio`;

export interface AudioConfig {
  weapons: {
    pistol: string;
    smg: string;
    rifle: string;
    shotgun: string;
  };
  player: {
    pain: string[];
    death: string[];
    painHeavy: string;
    painLight: string;
  };
  music: {
    ambient: string[];
    battle: string[];
  };
  impacts: {
    hit: string;
    critical: string;
    enemyDeath: string;
  };
  ui: {
    pickup: string;
    click: string;
    respawn: string;
  };
}

export const audioConfig: AudioConfig = {
  weapons: {
    pistol: `${AUDIO_BASE}/sfx/weapons/pistol.wav`,
    smg: `${AUDIO_BASE}/sfx/weapons/smg.wav`,
    rifle: `${AUDIO_BASE}/sfx/weapons/rifle.wav`,
    shotgun: `${AUDIO_BASE}/sfx/weapons/shotgun.wav`
  },
  player: {
    pain: [
      `${AUDIO_BASE}/sfx/player/pain1.wav`,
      `${AUDIO_BASE}/sfx/player/pain2.wav`,
      `${AUDIO_BASE}/sfx/player/pain3.wav`,
      `${AUDIO_BASE}/sfx/player/pain4.wav`,
      `${AUDIO_BASE}/sfx/player/pain5.wav`,
      `${AUDIO_BASE}/sfx/player/pain6.wav`
    ],
    death: [
      `${AUDIO_BASE}/sfx/player/death1.wav`,
      `${AUDIO_BASE}/sfx/player/die1.wav`,
      `${AUDIO_BASE}/sfx/player/die2.wav`
    ],
    painHeavy: `${AUDIO_BASE}/sfx/player/pain_heavy.wav`,
    painLight: `${AUDIO_BASE}/sfx/player/pain_light.wav`
  },
  music: {
    ambient: [
      `${AUDIO_BASE}/music/ambient/new_hero.mp3`,
      `${AUDIO_BASE}/music/ambient/ice_giants.mp3`,
      `${AUDIO_BASE}/music/ambient/release_hybrids.mp3`
    ],
    battle: [
      `${AUDIO_BASE}/music/battle/battle_ready.mp3`,
      `${AUDIO_BASE}/music/battle/evil_incoming.mp3`,
      `${AUDIO_BASE}/music/battle/honor_bound.mp3`
    ]
  },
  impacts: {
    hit: `${AUDIO_BASE}/sfx/player/pain_light.wav`, // Reuse light pain for hit marker
    critical: `${AUDIO_BASE}/sfx/player/pain_heavy.wav`, // Reuse heavy pain for critical
    enemyDeath: `${AUDIO_BASE}/sfx/player/death1.wav`
  },
  ui: {
    pickup: `${AUDIO_BASE}/sfx/weapons/smg.wav`, // Temporary: use SMG sound
    click: `${AUDIO_BASE}/sfx/weapons/pistol.wav`, // Temporary: use pistol sound
    respawn: `${AUDIO_BASE}/sfx/player/die1.wav` // Temporary: use death sound
  }
};

// Helper function to get random element from array
export function getRandomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// Helper to get pain sound based on damage amount
export function getPainSound(damage: number): string {
  if (damage >= 50) {
    return audioConfig.player.painHeavy;
  } else if (damage <= 10) {
    return audioConfig.player.painLight;
  } else {
    return getRandomElement(audioConfig.player.pain);
  }
}

// Helper to get random death sound
export function getRandomDeathSound(): string {
  return getRandomElement(audioConfig.player.death);
}

// Helper to get random ambient music
export function getRandomAmbientMusic(): string {
  return getRandomElement(audioConfig.music.ambient);
}

// Helper to get random battle music
export function getRandomBattleMusic(): string {
  return getRandomElement(audioConfig.music.battle);
}