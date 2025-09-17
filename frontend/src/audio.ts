import { Howl, Howler } from 'howler';
import * as THREE from 'three';
import { audioConfig } from './audioConfig';

interface SoundConfig {
  src: string[];
  volume?: number;
  loop?: boolean;
  preload?: boolean;
  spatial?: boolean;
}

interface PositionalSound {
  sound: Howl;
  id: number;
  position: THREE.Vector3;
}

class AudioManager {
  private sounds: Map<string, Howl> = new Map();
  private positionalSounds: Map<string, PositionalSound[]> = new Map();
  private musicVolume = 0.3;
  private sfxVolume = 0.7;
  private masterVolume = 1.0;
  private currentMusic: Howl | null = null;
  private currentMusicName: string | null = null;
  private listener: THREE.Vector3 = new THREE.Vector3();
  private listenerDirection: THREE.Vector3 = new THREE.Vector3(0, 0, -1);
  private enabled = true;
  private ambientPlaylist: string[] = [];
  private battlePlaylist: string[] = [];
  private ambientIndex = 0;
  private battleIndex = 0;

  constructor() {
    // Set up global volume
    Howler.volume(this.masterVolume);

    // Initialize with some placeholder sounds
    this.initializeSounds();
    this.setupPlaylists();
  }

  private initializeSounds() {
    // Weapon sounds from R2
    this.registerSound('pistol_fire', {
      src: [audioConfig.weapons.pistol],
      volume: 0.5,
      preload: true
    });

    this.registerSound('smg_fire', {
      src: [audioConfig.weapons.smg],
      volume: 0.4,
      preload: true
    });

    this.registerSound('rifle_fire', {
      src: [audioConfig.weapons.rifle],
      volume: 0.6,
      preload: true
    });

    this.registerSound('shotgun_fire', {
      src: [audioConfig.weapons.shotgun],
      volume: 0.7,
      preload: true
    });

    // Player damage sounds - register all variations
    audioConfig.player.pain.forEach((url, index) => {
      this.registerSound(`pain${index + 1}`, {
        src: [url],
        volume: 0.4,
        preload: true
      });
    });

    this.registerSound('pain_heavy', {
      src: [audioConfig.player.painHeavy],
      volume: 0.5,
      preload: true
    });

    this.registerSound('pain_light', {
      src: [audioConfig.player.painLight],
      volume: 0.3,
      preload: true
    });

    // Death sounds
    audioConfig.player.death.forEach((url, index) => {
      this.registerSound(`death${index + 1}`, {
        src: [url],
        volume: 0.5,
        preload: true
      });
    });

    // Impact sounds
    this.registerSound('hit_marker', {
      src: [audioConfig.impacts.hit],
      volume: 0.3,
      preload: true
    });

    this.registerSound('critical_hit', {
      src: [audioConfig.impacts.critical],
      volume: 0.5,
      preload: true
    });

    this.registerSound('enemy_death', {
      src: [audioConfig.impacts.enemyDeath],
      volume: 0.4,
      preload: true
    });

    // UI sounds
    this.registerSound('pickup', {
      src: [audioConfig.ui.pickup],
      volume: 0.5,
      preload: true
    });

    this.registerSound('menu_click', {
      src: [audioConfig.ui.click],
      volume: 0.3,
      preload: true
    });

    this.registerSound('respawn', {
      src: [audioConfig.ui.respawn],
      volume: 0.6,
      preload: true
    });

    // Background music - register all tracks
    audioConfig.music.ambient.forEach((url, index) => {
      this.registerSound(`ambient_music_${index}`, {
        src: [url],
        volume: 0.3,
        loop: true,
        preload: false
      });
    });

    audioConfig.music.battle.forEach((url, index) => {
      this.registerSound(`battle_music_${index}`, {
        src: [url],
        volume: 0.4,
        loop: true,
        preload: false
      });
    });
  }

  registerSound(name: string, config: SoundConfig) {
    const sound = new Howl({
      src: config.src,
      volume: (config.volume ?? 1.0) * this.sfxVolume,
      loop: config.loop ?? false,
      preload: config.preload ?? true,
      html5: !config.spatial, // Use HTML5 Audio for non-spatial sounds
    });

    this.sounds.set(name, sound);
  }

  play(name: string, options?: { volume?: number; rate?: number }): number | null {
    if (!this.enabled) return null;

    const sound = this.sounds.get(name);
    if (!sound) {
      console.warn(`Sound "${name}" not found`);
      return null;
    }

    const id = sound.play();

    if (options?.volume !== undefined) {
      sound.volume(options.volume * this.sfxVolume, id);
    }

    if (options?.rate !== undefined) {
      sound.rate(options.rate, id);
    }

    return id;
  }

  play3D(name: string, position: THREE.Vector3, options?: {
    volume?: number;
    maxDistance?: number;
    refDistance?: number;
  }): PositionalSound | null {
    if (!this.enabled) return null;

    const sound = this.sounds.get(name);
    if (!sound) {
      console.warn(`Sound "${name}" not found`);
      return null;
    }

    // Clone the sound for positional playback
    const spatialSound = new Howl({
      src: (sound as any)._src as string[],
      volume: (options?.volume ?? 1.0) * this.sfxVolume,
      html5: false, // Force Web Audio API for 3D sound
    });

    const id = spatialSound.play();

    // Calculate distance and panning
    const dx = position.x - this.listener.x;
    const dy = position.y - this.listener.y;
    const dz = position.z - this.listener.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const maxDist = options?.maxDistance ?? 50;
    const refDist = options?.refDistance ?? 1;

    // Calculate volume falloff
    const rolloff = Math.max(0, 1 - (distance - refDist) / (maxDist - refDist));
    spatialSound.volume(rolloff * (options?.volume ?? 1.0) * this.sfxVolume, id);

    // Calculate stereo panning based on listener direction
    const right = new THREE.Vector3();
    right.crossVectors(this.listenerDirection, new THREE.Vector3(0, 1, 0)).normalize();
    const pan = Math.max(-1, Math.min(1, right.dot(new THREE.Vector3(dx, dy, dz).normalize())));
    spatialSound.stereo(pan, id);

    const positionalSound: PositionalSound = {
      sound: spatialSound,
      id,
      position: position.clone()
    };

    // Store for cleanup
    if (!this.positionalSounds.has(name)) {
      this.positionalSounds.set(name, []);
    }
    this.positionalSounds.get(name)!.push(positionalSound);

    // Auto cleanup when sound ends
    spatialSound.on('end', () => {
      const sounds = this.positionalSounds.get(name);
      if (sounds) {
        const index = sounds.indexOf(positionalSound);
        if (index > -1) {
          sounds.splice(index, 1);
        }
      }
    });

    return positionalSound;
  }

  updateListener(position: THREE.Vector3, direction: THREE.Vector3) {
    this.listener.copy(position);
    this.listenerDirection.copy(direction);

    // Update Howler's global listener position
    Howler.pos(position.x, position.y, position.z);
    Howler.orientation(
      direction.x, direction.y, direction.z,
      0, 1, 0 // Up vector
    );
  }

  private shufflePlaylist(list: string[]) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  private setupPlaylists() {
    this.ambientPlaylist = audioConfig.music.ambient.map((_, idx) => `ambient_music_${idx}`);
    this.battlePlaylist = audioConfig.music.battle.map((_, idx) => `battle_music_${idx}`);
    if (this.ambientPlaylist.length > 1) this.shufflePlaylist(this.ambientPlaylist);
    if (this.battlePlaylist.length > 1) this.shufflePlaylist(this.battlePlaylist);
    this.ambientIndex = 0;
    this.battleIndex = 0;
  }

  private getNextTrack(type: 'ambient' | 'battle'): string | null {
    const playlist = type === 'ambient' ? this.ambientPlaylist : this.battlePlaylist;
    if (playlist.length === 0) return null;

    let index = type === 'ambient' ? this.ambientIndex : this.battleIndex;
    let track = playlist[index];
    let attempts = 0;

    while (playlist.length > 1 && track === this.currentMusicName && attempts < playlist.length) {
      index = (index + 1) % playlist.length;
      track = playlist[index];
      attempts++;
    }

    const nextIndex = (index + 1) % playlist.length;
    if (type === 'ambient') {
      this.ambientIndex = nextIndex;
      if (this.ambientIndex === 0 && playlist.length > 1) this.shufflePlaylist(this.ambientPlaylist);
    } else {
      this.battleIndex = nextIndex;
      if (this.battleIndex === 0 && playlist.length > 1) this.shufflePlaylist(this.battlePlaylist);
    }

    return track;
  }

  playMusic(name: string, fadeInTime = 1000) {
    if (!this.enabled) return;

    const newMusic = this.sounds.get(name);
    if (!newMusic) {
      console.warn(`Music "${name}" not found`);
      return;
    }

    // Fade out current music if playing
    if (this.currentMusic && this.currentMusic.playing()) {
      this.currentMusic.fade(this.currentMusic.volume(), 0, fadeInTime);
      this.currentMusic.once('fade', () => {
        this.currentMusic?.stop();
      });
    }

    // Start new music
    this.currentMusic = newMusic;
    this.currentMusicName = name;
    this.currentMusic.volume(0);
    this.currentMusic.play();
    this.currentMusic.fade(0, this.musicVolume, fadeInTime);
  }

  stopMusic(fadeOutTime = 1000) {
    if (this.currentMusic && this.currentMusic.playing()) {
      this.currentMusic.fade(this.currentMusic.volume(), 0, fadeOutTime);
      this.currentMusic.once('fade', () => {
        this.currentMusic?.stop();
        this.currentMusic = null;
        this.currentMusicName = null;
      });
    }
  }

  setMasterVolume(volume: number) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    Howler.volume(this.masterVolume);
  }

  setSFXVolume(volume: number) {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
    // Update all non-music sounds
    this.sounds.forEach((sound, name) => {
      if (name.includes('music')) return;
      sound.volume(this.sfxVolume);
    });
  }

  setMusicVolume(volume: number) {
    this.musicVolume = Math.max(0, Math.min(1, volume));
    if (this.currentMusic) {
      this.currentMusic.volume(this.musicVolume);
    }
  }

  mute() {
    this.enabled = false;
    Howler.mute(true);
  }

  unmute() {
    this.enabled = true;
    Howler.mute(false);
  }

  toggle() {
    if (this.enabled) {
      this.mute();
    } else {
      this.unmute();
    }
  }

  // Play random pain sound based on damage amount
  playPainSound(damage: number, position?: THREE.Vector3) {
    const soundIndex = damage >= 50 ? 'pain_heavy' :
                      damage <= 10 ? 'pain_light' :
                      `pain${Math.floor(Math.random() * 6) + 1}`;

    if (position) {
      return this.play3D(soundIndex, position);
    } else {
      return this.play(soundIndex);
    }
  }

  // Play random death sound
  playDeathSound(position?: THREE.Vector3) {
    const soundIndex = `death${Math.floor(Math.random() * 3) + 1}`;
    if (position) {
      return this.play3D(soundIndex, position);
    } else {
      return this.play(soundIndex);
    }
  }

  // Start ambient music (random track)
  startAmbientMusic() {
    const trackName = this.getNextTrack('ambient');
    if (trackName) {
      this.playMusic(trackName, 2000);
    }
  }

  // Start battle music (random track)
  startBattleMusic() {
    const trackName = this.getNextTrack('battle');
    if (trackName) {
      this.playMusic(trackName, 1000);
    }
  }

  // Dynamic music system - switch based on combat intensity
  private combatIntensity = 0;
  private musicMode: 'ambient' | 'battle' = 'ambient';

  updateCombatIntensity(enemiesNearby: number, takingDamage: boolean) {
    // Calculate intensity based on game state
    const targetIntensity = enemiesNearby * 10 + (takingDamage ? 20 : 0);

    // Smoothly transition intensity
    this.combatIntensity += (targetIntensity - this.combatIntensity) * 0.1;

    // Switch music based on intensity threshold
    if (this.combatIntensity > 30 && this.musicMode === 'ambient') {
      this.musicMode = 'battle';
      this.startBattleMusic();
    } else if (this.combatIntensity < 10 && this.musicMode === 'battle') {
      this.musicMode = 'ambient';
      this.startAmbientMusic();
    }
  }

  cleanup() {
    // Stop all sounds
    this.sounds.forEach(sound => sound.unload());
    this.sounds.clear();

    // Clean up positional sounds
    this.positionalSounds.forEach(sounds => {
      sounds.forEach(ps => ps.sound.unload());
    });
    this.positionalSounds.clear();

    // Stop music
    if (this.currentMusic) {
      this.currentMusic.stop();
      this.currentMusic = null;
    }
    this.currentMusicName = null;
  }
}

// Create singleton instance
export const audioManager = new AudioManager();
