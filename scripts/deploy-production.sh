#!/bin/bash

# Deploy Borderboxes to production
# This script builds and deploys both frontend and API to Cloudflare

echo "🚀 Starting production deployment for Borderboxes..."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Deploy API
echo -e "${YELLOW}📦 Deploying API...${NC}"
cd /Users/tristankennedy/bordercans/api
npm run deploy
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ API deployed successfully to https://borderboxes-api.highfive.workers.dev${NC}"
else
    echo "❌ API deployment failed"
    exit 1
fi

echo ""

# Build and deploy frontend
echo -e "${YELLOW}🏗️  Building frontend...${NC}"
cd /Users/tristankennedy/bordercans/frontend
npm run build
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Frontend built successfully${NC}"
else
    echo "❌ Frontend build failed"
    exit 1
fi

echo ""
echo -e "${YELLOW}🌍 Deploying frontend...${NC}"
npx wrangler pages deploy dist --project-name borderboxes --commit-dirty=true
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Frontend deployed successfully to https://borderboxes.pages.dev${NC}"
else
    echo "❌ Frontend deployment failed"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 Production deployment complete!${NC}"
echo ""
echo "📍 Production URLs:"
echo "   Frontend: https://borderboxes.pages.dev"
echo "   API: https://borderboxes-api.highfive.workers.dev"
echo "   Audio: https://borderboxes-api.highfive.workers.dev/audio/"
echo ""
echo "🎮 Happy gaming!"