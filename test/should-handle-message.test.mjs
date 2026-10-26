// Self-check for the incoming-message filter.
// Run: node test/should-handle-message.test.mjs
import assert from 'node:assert';
import { shouldHandleMessage } from '../index.js';

const OWN = '628123456789:12@s.whatsapp.net';
const OTHER = '628999999999:1@s.whatsapp.net';
const msg = (remoteJid, fromMe, conversation) => ({ key: { remoteJid, fromMe }, message: { conversation } });

// The bot is paired with the owner's own number, so commands the owner sends arrive
// with fromMe=true. This is the case that used to be dropped, leaving the bot silent.
assert.equal(shouldHandleMessage(msg(OWN, true, '.ping'), OWN), true, 'owner self-chat must be handled');

// A different number messaging the bot still works.
assert.equal(shouldHandleMessage(msg(OTHER, false, '.ping'), OWN), true, 'other senders must be handled');

// The bot's own outgoing messages in other chats are still ignored.
assert.equal(shouldHandleMessage(msg('120363000000000000@g.us', true, '.ping'), OWN), false, 'own group messages must be dropped');
assert.equal(shouldHandleMessage(msg(OTHER, true, '.ping'), OWN), false, 'fromMe from another chat must be dropped');

// Noise is still ignored.
assert.equal(shouldHandleMessage(msg('status@broadcast', false, 'x'), OWN), false, 'status broadcast must be dropped');
assert.equal(shouldHandleMessage(msg('12345@newsletter', false, 'x'), OWN), false, 'newsletter must be dropped');
assert.equal(shouldHandleMessage({ key: { remoteJid: OTHER, fromMe: false } }, OWN), false, 'no payload must be dropped');

console.log('shouldHandleMessage: all assertions passed');
process.exit(0);
