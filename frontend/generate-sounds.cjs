// Simple script to generate placeholder sound files
// These are basic synthesized sounds to test the audio system
// Replace with real CC0 sounds later

const fs = require('fs');
const path = require('path');

// WAV file header generator
function createWavHeader(dataLength, sampleRate = 44100) {
  const buffer = Buffer.alloc(44);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (mono)
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

// Generate a simple tone
function generateTone(frequency, duration, sampleRate = 44100) {
  const samples = Math.floor(sampleRate * duration);
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const value = Math.sin(2 * Math.PI * frequency * t);
    const amplitude = Math.exp(-t * 3); // Decay envelope
    const sample = Math.floor(value * amplitude * 32767);
    data.writeInt16LE(sample, i * 2);
  }

  return Buffer.concat([createWavHeader(data.length, sampleRate), data]);
}

// Generate noise burst
function generateNoise(duration, sampleRate = 44100) {
  const samples = Math.floor(sampleRate * duration);
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const value = (Math.random() - 0.5) * 2;
    const amplitude = Math.exp(-t * 10); // Fast decay
    const sample = Math.floor(value * amplitude * 32767);
    data.writeInt16LE(sample, i * 2);
  }

  return Buffer.concat([createWavHeader(data.length, sampleRate), data]);
}

// Generate click sound
function generateClick(sampleRate = 44100) {
  const samples = Math.floor(sampleRate * 0.01);
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i++) {
    const value = i < 10 ? 1 : 0;
    const sample = Math.floor(value * 16383);
    data.writeInt16LE(sample, i * 2);
  }

  return Buffer.concat([createWavHeader(data.length, sampleRate), data]);
}

// Create directories if they don't exist
const audioDir = path.join(__dirname, 'public', 'audio');
const dirs = [
  path.join(audioDir, 'sfx', 'weapons'),
  path.join(audioDir, 'sfx', 'impacts'),
  path.join(audioDir, 'sfx', 'ui'),
  path.join(audioDir, 'sfx', 'environment'),
  path.join(audioDir, 'music')
];

dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Generate sound files
const sounds = [
  { file: 'sfx/weapons/pistol.wav', generator: () => generateTone(800, 0.1) },
  { file: 'sfx/weapons/smg.wav', generator: () => generateNoise(0.05) },
  { file: 'sfx/weapons/rifle.wav', generator: () => generateTone(400, 0.15) },
  { file: 'sfx/impacts/hit.wav', generator: () => generateTone(200, 0.05) },
  { file: 'sfx/impacts/critical.wav', generator: () => generateTone(1200, 0.1) },
  { file: 'sfx/impacts/death.wav', generator: () => generateTone(100, 0.3) },
  { file: 'sfx/ui/pickup.wav', generator: () => generateTone(600, 0.2) },
  { file: 'sfx/ui/click.wav', generator: () => generateClick() },
  { file: 'sfx/ui/respawn.wav', generator: () => generateTone(440, 0.5) },
  { file: 'sfx/environment/footstep.wav', generator: () => generateNoise(0.02) },
  { file: 'sfx/environment/jump.wav', generator: () => generateTone(300, 0.1) },
];

sounds.forEach(({ file, generator }) => {
  const filePath = path.join(audioDir, file);
  const wavData = generator();
  fs.writeFileSync(filePath, wavData);
  console.log(`Generated: ${file}`);
});

// Create simple ambient "music" (just a low drone for testing)
const musicDuration = 10; // 10 seconds, will loop
const musicSamples = 44100 * musicDuration;
const musicData = Buffer.alloc(musicSamples * 2);

for (let i = 0; i < musicSamples; i++) {
  const t = i / 44100;
  const value = Math.sin(2 * Math.PI * 110 * t) * 0.1 + // Bass drone
                Math.sin(2 * Math.PI * 220 * t) * 0.05 + // Harmony
                Math.sin(2 * Math.PI * 55 * t) * 0.05; // Sub bass
  const sample = Math.floor(value * 16383);
  musicData.writeInt16LE(sample, i * 2);
}

fs.writeFileSync(
  path.join(audioDir, 'music', 'ambient.wav'),
  Buffer.concat([createWavHeader(musicData.length), musicData])
);
console.log('Generated: music/ambient.wav');

// Combat music (more intense)
for (let i = 0; i < musicSamples; i++) {
  const t = i / 44100;
  const beat = Math.sin(2 * Math.PI * 2 * t) > 0 ? 1 : 0; // 2Hz beat
  const value = Math.sin(2 * Math.PI * 150 * t) * 0.2 * beat + // Rhythmic bass
                Math.sin(2 * Math.PI * 300 * t) * 0.1 + // Mid
                (Math.random() - 0.5) * 0.02; // Noise
  const sample = Math.floor(value * 16383);
  musicData.writeInt16LE(sample, i * 2);
}

fs.writeFileSync(
  path.join(audioDir, 'music', 'combat.wav'),
  Buffer.concat([createWavHeader(musicData.length), musicData])
);
console.log('Generated: music/combat.wav');

console.log('\nPlaceholder sounds generated successfully!');
console.log('These are basic synthesized sounds for testing.');
console.log('Replace with real CC0 sounds from the resources mentioned.');