// Self-check for the incoming-message filter.
// Run: node test/should-handle-message.test.mjs
import assert from 'node:assert';
import { Chess } from 'chess.js';
import { shouldHandleMessage, boardText, applyMove, startClock, finishIfNeeded, eloLeaderboard } from '../index.js';

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

// --- chess: board + move validation, clock, ELO ---
const newGame = () => ({ id: 't', chess: new Chess(), players: [null, null], sockets: new Map(), createdAt: 0, lastMove: null, chatJid: null, token: 'tok', phase: 'lobby', choice: {}, seats: { w: null, b: null }, time: null, flagged: null, result: null });

const txt = boardText(new Chess());
assert.ok(txt.includes('a b c d e f g h'), 'text board must label the files');
assert.equal(txt.split('\n').length, 9, 'text board must be 8 ranks + file labels');
assert.ok(txt.includes('♙') && txt.includes('♟'), 'both pawn colours must render');

const g = newGame();
assert.equal(applyMove(g, 'e2', 'e4').ok, false, 'moves must be refused while in the lobby');
startClock(g, 10);
assert.equal(g.phase, 'playing');
assert.equal(g.time.mode, 10);
assert.equal(g.time.w, 10 * 60 * 1000, 'clock starts full for both sides');

assert.equal(g.chess.turn(), 'w');
let r = applyMove(g, 'e2', 'e4');
assert.equal(r.ok, true, 'e2e4 must be legal');
assert.equal(g.chess.turn(), 'b', 'turn must pass to black');
assert.equal(g.lastMove.san, 'e4');
assert.ok(g.time.w < 10 * 60 * 1000, 'moving must spend the mover clock');
assert.ok(g.time.b === 10 * 60 * 1000, 'the waiting side keeps its clock');
assert.equal(applyMove(g, 'e2', 'e4').ok, false, 'a moved-from square must be rejected');
assert.equal(applyMove(g, 'e7', 'e5').ok, true, 'e7e5 must be legal');
assert.equal(applyMove(g, 'e7', 'e5').ok, false, 'the same move cannot be repeated');

// a side whose clock is already at zero cannot move and loses on time
const flag = newGame();
startClock(flag, 1);
flag.seats = { w: 'p1', b: 'p2' };
applyMove(flag, 'e2', 'e4');
flag.time.b = 0;
const late = applyMove(flag, 'e7', 'e5');
assert.equal(late.ok, false, 'a side with no time left cannot move');
assert.equal(late.error, 'Waktu habis.');
assert.equal(flag.flagged, 'b', 'the side whose clock hit zero must be flagged');
assert.equal(finishIfNeeded(flag), true, 'a flagged game must end');
assert.equal(flag.phase, 'over');
assert.equal(flag.result.loser, 'b');
assert.equal(flag.result.reason, 'waktu habis');

// scholar's mate must be checkmate and settle the ELO for both seats
const m = newGame();
startClock(m, 15);
m.seats = { w: 'alice', b: 'bob' };
for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']]) {
  const mv = applyMove(m, from, to);
  assert.equal(mv.ok, true, `${from}${to} must be legal`);
}
assert.equal(m.chess.isCheckmate(), true, "scholar's mate must be checkmate");
assert.equal(finishIfNeeded(m), true, 'a mate must end the game');
assert.equal(m.phase, 'over');
assert.equal(m.result.loser, 'b', 'black is mated, so black lost');
assert.equal(m.result.reason, 'skakmat');
assert.equal(applyMove(m, 'a1', 'a2').ok, false, 'no moves after game over');

// ELO: the winner's rating must rise above the 1000 baseline, the loser's must fall
const board = eloLeaderboard();
const alice = board.find(x => x.name === 'alice');
const bob = board.find(x => x.name === 'bob');
assert.ok(alice && alice.rating > 1000, `winner rating must rise, got ${alice && alice.rating}`);
assert.ok(bob && bob.rating < 1000, `loser rating must fall, got ${bob && bob.rating}`);
assert.equal(alice.w, 1, 'winner needs a win on record');
assert.equal(bob.l, 1, 'loser needs a loss on record');
assert.equal(alice.rating + bob.rating, 2000, 'a decisive game must be rating-neutral overall');

// the clock is what stops an endless game: a 1-minute flag game ends by time
const timed = newGame();
startClock(timed, 1);
timed.seats = { w: 'x', b: 'y' };
applyMove(timed, 'd2', 'd4');
timed.time.w = 0;
applyMove(timed, 'd7', 'd5');
assert.equal(timed.flagged, null, 'black still has time, so nothing flags yet');
const tooLate = applyMove(timed, 'c2', 'c4');
assert.equal(tooLate.ok, false, 'white cannot move with an empty clock');
assert.equal(timed.flagged, 'w');
finishIfNeeded(timed);
assert.equal(timed.result.loser, 'w', 'white ran out of time');

console.log('chess board + clock + move validation: all assertions passed');
process.exit(0);
