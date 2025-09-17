#!/bin/bash

# Upload audio files to Cloudflare R2 bucket
# This script uploads all sound files from the Downloads folders to R2

echo "Starting audio upload to Cloudflare R2..."

# Change to API directory for wrangler access
cd /Users/tristankennedy/bordercans/api

# Create directory structure in R2 and upload files
echo "Uploading weapon sounds..."

# Weapon sounds
npx wrangler r2 object put borderboxes-audio/sfx/weapons/pistol.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/shots/pistol.wav"
npx wrangler r2 object put borderboxes-audio/sfx/weapons/rifle.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/shots/rifle.wav"
npx wrangler r2 object put borderboxes-audio/sfx/weapons/shotgun.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/shots/shotgun.wav"
npx wrangler r2 object put borderboxes-audio/sfx/weapons/smg.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/shots/cg1.wav"

echo "Uploading player damage sounds..."

# Player damage sounds
npx wrangler r2 object put borderboxes-audio/sfx/player/pain1.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/pain1.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain2.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/pain2.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain3.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/pain3.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain4.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/pain4.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain5.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/pain5.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain6.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/pain6.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain_heavy.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/painh.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/pain_light.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/paino.wav"

# Player death sounds
npx wrangler r2 object put borderboxes-audio/sfx/player/death1.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/deathh.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/die1.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/die1.wav"
npx wrangler r2 object put borderboxes-audio/sfx/player/die2.wav --remote --file="/Users/tristankennedy/Downloads/soudneffects/player/die2.wav"

echo "Uploading epic battle music..."

# Epic battle music
npx wrangler r2 object put "borderboxes-audio/music/battle/battle_ready.mp3" --remote --file="/Users/tristankennedy/Downloads/epicbattlemusic/Battle Ready.mp3"
npx wrangler r2 object put "borderboxes-audio/music/battle/evil_incoming.mp3" --remote --file="/Users/tristankennedy/Downloads/epicbattlemusic/Evil Incoming.mp3"
npx wrangler r2 object put "borderboxes-audio/music/battle/honor_bound.mp3" --remote --file="/Users/tristankennedy/Downloads/epicbattlemusic/Honor Bound.mp3"
npx wrangler r2 object put "borderboxes-audio/music/ambient/new_hero.mp3" --remote --file="/Users/tristankennedy/Downloads/epicbattlemusic/New Hero in Town.mp3"
npx wrangler r2 object put "borderboxes-audio/music/ambient/release_hybrids.mp3" --remote --file="/Users/tristankennedy/Downloads/epicbattlemusic/Release the Hybrids.mp3"
npx wrangler r2 object put "borderboxes-audio/music/ambient/ice_giants.mp3" --remote --file="/Users/tristankennedy/Downloads/epicbattlemusic/The Ice Giants.mp3"

echo "All audio files uploaded successfully!"
echo "Files are now available in the borderboxes-audio R2 bucket"