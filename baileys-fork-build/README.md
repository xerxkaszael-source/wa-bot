# Baileys Web Pairing Bot (fixed)
Node.js + Baileys + Express. Web UI requests a pairing code without displaying QR.

## Render
- Build command: `npm install`
- Start command: `npm start`
- Node.js 20+
- Set `PAIRING_TOKEN` in Render Environment to a long random secret, then enter it when prompted by the web UI.
- Render Free may sleep and does not guarantee 24/7 uptime. Its local filesystem is not persistent, so the WhatsApp auth session may be lost on restart/redeploy. Use persistent storage if your plan supports it.
- Do not commit `auth_info`, API keys, or other secrets.

## Pair
1. Enter your own WhatsApp phone number in international format, digits only (e.g. `628123456789`).
2. Click request pairing code.
3. In WhatsApp: Linked devices > Link a device > Link with phone number instead.
4. Enter the exact code shown. Baileys/WhatsApp controls the code format; it is not guaranteed to be eight numeric digits.

The code waits for Baileys' initial socket-ready QR event before requesting a pairing code. It also handles restart-required disconnects by reconnecting.
