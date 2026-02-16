# AntiAlgo.ai Website - Landing Page

## Overview

**Service Name:** AntiAlgo.ai Website  
**URL:** antialgo.ai/ or antialgo.ai/home  
**Purpose:** Public landing page, newsletter signup, subscriber management  
**Type:** React + Vite + Tailwind (Light theme with white backgrounds)

## Folder Structure

This website is located in: `/curiosity-website 2/`

- **src/pages/Landing.tsx** - Main homepage (newsletter signup form)
- **src/pages/Confirm.tsx** - Email confirmation flow
- **src/pages/Referral.tsx** - Referral tracking page
- **src/pages/Archive.tsx** - Archive of past newsletters
- **src/pages/Unsubscribe.tsx** - Unsubscribe management
- **src/lib/api.ts** - API client for subscribers

## Running Locally

```bash
cd "curiosity-website 2"
npm run dev -- --port 3001
```

Visit: http://localhost:3001/

## Deployment

- **Production URL:** https://antialgo.ai
- **Deployed to:** Vercel
- **Config:** `vercel.json`
- **Package:** `package.json`

## Design System

- **Theme:** Light (white backgrounds, dark text)
- **Framework:** Jony Ive design system
- **CSS:** Tailwind (see `tailwind.config.js`)
- **Animations:** Framer Motion

## Key Features

✅ Newsletter signup form  
✅ Subscriber confirmation flow  
✅ Referral system  
✅ Newsletter archive  
✅ Unsubscribe management  
✅ Responsive design  

## NOT This Service

❌ This is NOT the Dashboard  
❌ This is NOT for monitoring signals  
❌ This is NOT for analytics  

See `/curiosity-intelligence 1/dashboard/` for the Dashboard.
