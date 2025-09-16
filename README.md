# Borderboxes

A multiplayer voxel shooter built with Three.js and Cloudflare Workers. Think Minecraft meets Borderlands, but way more chaotic.

🎮 **Play Now**: [borderboxes.pages.dev](https://borderboxes.pages.dev)

## ⚠️ Warning

This game is:
- Insanely difficult
- Rough around the edges
- Full of aggressive cube enemies
- Likely to cause rage

You've been warned.

## 🎮 Controls

- **WASD** - Move
- **Mouse** - Look around
- **Left Click** - Shoot
- **Shift** - Sprint
- **C** - Crouch
- **Ctrl** - Slide
- **E** - Pickup loot
- **1-5** - Switch weapons

## 🛠 Tech Stack

- **Frontend**: Three.js, TypeScript, Vite
- **Backend**: Cloudflare Workers with Durable Objects
- **Database**: Cloudflare D1
- **Hosting**: Cloudflare Pages
- **Real-time**: WebSockets for multiplayer

## 🚀 Features

- Real-time multiplayer
- Procedural weapon generation with rarity tiers
- Multiple enemy types with different AI behaviors
- Physics system with gravity
- Death and respawn mechanics
- Cel-shaded graphics
- Runs entirely in browser - no download needed

## 🏗 Development

### Prerequisites
- Node.js 18+
- Cloudflare account
- Wrangler CLI

### Local Setup

```bash
# Clone the repo
git clone https://github.com/triken22/borderboxes.git
cd borderboxes

# Install dependencies
cd api && npm install
cd ../frontend && npm install

# Run locally
# Terminal 1 - API
cd api && npm run dev

# Terminal 2 - Frontend
cd frontend && npm run dev
```

### Deployment

```bash
# Deploy API
cd api && npx wrangler deploy

# Deploy Frontend
cd frontend && npm run build
npx wrangler pages deploy dist --project-name=borderboxes
```

## 🐛 Known Issues

- Enemies occasionally defy physics
- Movement can feel janky
- Difficulty balance is... non-existent
- Various visual glitches

## 📝 License

MIT

## 🤝 Contributing

PRs welcome! This is a weekend project that got out of hand, so there's plenty to improve.

---

Built with determination and questionable design decisions.