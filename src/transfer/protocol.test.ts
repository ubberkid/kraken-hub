import { describe, expect, it } from 'vitest';

import { MAX_ENVELOPE_BYTES } from '../sync/types';

import {
  TRANSFER_BODY_BUDGET_BYTES,
  TRANSFER_BUFFER_HIGH_BYTES,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_ENVELOPE_CAP_BYTES,
  TRANSFER_ICE_MAX,
  bodyBytes,
  chunkCount,
  createAssembler,
  fitCandidates,
  isPictureFile,
  parseTransferAnswer,
  parseTransferIce,
  parseTransferOffer,
  parseTransferProgress,
  shouldPause,
  signalFits,
  type WireCandidate,
} from './protocol';

/**
 * The parts of a peer-to-peer transfer that can be wrong without a browser.
 *
 * Everything that needs an `RTCPeerConnection` is exercised end-to-end in
 * `tests/e2e/lan-transfer.spec.ts`, over a REAL loopback connection between two
 * pages. What is here is the arithmetic and the wire shapes — the two things
 * that fail silently rather than loudly, because an oversized signalling body is
 * DROPPED by the envelope encoder and a mis-sized assembler produces a file that
 * is subtly not the file that was sent.
 */

describe('the envelope cap is not guessed', () => {
  it('matches the sync layer’s own constant', () => {
    // Copied rather than imported at runtime — see the header of `protocol.ts`
    // and the identical arrangement in `chunkedTele`. This is what stops the
    // copy from drifting.
    expect(TRANSFER_ENVELOPE_CAP_BYTES).toBe(MAX_ENVELOPE_BYTES);
    expect(TRANSFER_BODY_BUDGET_BYTES).toBeLessThan(TRANSFER_ENVELOPE_CAP_BYTES);
  });

  it('a realistic data-channel offer fits one envelope', () => {
    // A data-channel-only SDP is ~1.2 KB; 3 KB is a generous stand-in, and the
    // point of the assertion is that the design does not need chunking here.
    const body = {
      sid: 'abc123def456',
      name: 'clip.mp4',
      size: 12_345,
      mime: 'video/mp4',
      sdp: 'v=0\n'.repeat(750),
    };
    expect(bodyBytes(body)).toBeLessThan(TRANSFER_BODY_BUDGET_BYTES);
    expect(signalFits(body)).toBe(true);
  });
});

describe('cumulative ICE fits, by dropping the oldest', () => {
  const candidate = (i: number): WireCandidate => ({
    c: `candidate:${String(i)} 1 udp 2122260223 192.168.1.${String(i)} 5${String(i)}000 typ host generation 0 ufrag AbCd network-id 1`,
    m: '0',
    i: 0,
  });

  it('keeps at most the cap, newest last', () => {
    const many = Array.from({ length: TRANSFER_ICE_MAX + 8 }, (_, i) => candidate(i));
    const fitted = fitCandidates('sid1', many);
    expect(fitted).toHaveLength(TRANSFER_ICE_MAX);
    // A strict SUFFIX of what was gathered: the peer already has the early
    // host candidates (every previous message carried them), so truncating from
    // the front never removes something the peer has not already seen.
    expect(fitted[fitted.length - 1]).toEqual(many[many.length - 1]);
  });

  it('never produces a body the envelope would refuse', () => {
    const huge = Array.from({ length: TRANSFER_ICE_MAX }, () => ({ c: 'x'.repeat(2000) }));
    const fitted = fitCandidates('sid1', huge);
    expect(signalFits({ sid: 'sid1', candidates: fitted })).toBe(true);
  });
});

describe('the wire shapes are checked, once, at the boundary', () => {
  it('an offer without a size, a name or an SDP is not an offer', () => {
    const good = { sid: 's', name: 'a.mp4', size: 10, mime: 'video/mp4', sdp: 'v=0' };
    expect(parseTransferOffer(good)).toEqual(good);
    expect(parseTransferOffer({ ...good, size: 0 })).toBeNull();
    expect(parseTransferOffer({ ...good, size: -1 })).toBeNull();
    expect(parseTransferOffer({ ...good, sdp: '' })).toBeNull();
    expect(parseTransferOffer({ ...good, name: '' })).toBeNull();
    expect(parseTransferOffer(null)).toBeNull();
    // A missing mime is normal — a document provider hands over a typeless file
    // — so it degrades to empty rather than rejecting.
    expect(parseTransferOffer({ ...good, mime: undefined })?.mime).toBe('');
  });

  it('an answer carries an SDP or a refusal, and nothing else counts', () => {
    expect(parseTransferAnswer({ kind: 'transferAnswer', sid: 's', sdp: 'v=0' })?.sdp).toBe('v=0');
    expect(
      parseTransferAnswer({ kind: 'transferAnswer', sid: 's', refused: 'quota', detail: 'no room' })
        ?.refused,
    ).toBe('quota');
    expect(parseTransferAnswer({ kind: 'transferAnswer', sid: 's' })).toBeNull();
    expect(
      parseTransferAnswer({ kind: 'transferAnswer', sid: 's', refused: 'weather' }),
    ).toBeNull();
    // Another packet on the shared `tele` channel must read as "not mine".
    expect(parseTransferAnswer({ kind: 'videoStats', sid: 's', sdp: 'v=0' })).toBeNull();
  });

  it('an empty candidate list is a valid message — "nothing yet"', () => {
    expect(parseTransferIce({ sid: 's', candidates: [] })).toEqual({ sid: 's', candidates: [] });
    expect(parseTransferIce({ sid: 's' })).toBeNull();
    const parsed = parseTransferIce({
      sid: 's',
      candidates: [{ c: 'x', m: '0', i: 0 }, { m: '0' }],
    });
    expect(parsed?.candidates).toEqual([{ c: 'x', m: '0', i: 0 }]);
  });

  it('progress is only progress when its state is one this app knows', () => {
    expect(
      parseTransferProgress({
        kind: 'transferProgress',
        sid: 's',
        received: 5,
        total: 10,
        state: 'receiving',
      })?.received,
    ).toBe(5);
    expect(
      parseTransferProgress({ kind: 'transferProgress', sid: 's', state: 'thinking' }),
    ).toBeNull();
  });
});

describe('chunking and backpressure', () => {
  it('counts 16 KB messages, and never fewer than one', () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(TRANSFER_CHUNK_BYTES)).toBe(1);
    expect(chunkCount(TRANSFER_CHUNK_BYTES + 1)).toBe(2);
    expect(chunkCount(TRANSFER_CHUNK_BYTES * 10)).toBe(10);
  });

  it('pauses at the high-water mark and not before', () => {
    // `send()` never blocks and never refuses — it queues. A loop that ignores
    // this queues a 400 MB file into memory and takes the tab with it.
    expect(shouldPause(0)).toBe(false);
    expect(shouldPause(TRANSFER_BUFFER_HIGH_BYTES - 1)).toBe(false);
    expect(shouldPause(TRANSFER_BUFFER_HIGH_BYTES)).toBe(true);
  });
});

describe('the assembler', () => {
  const chunk = (n: number, fill: number): ArrayBuffer => new Uint8Array(n).fill(fill).buffer;

  it('joins the parts back into exactly the declared size', async () => {
    const assembler = createAssembler({ size: 30, mime: 'video/mp4' });
    expect(assembler.complete).toBe(false);
    expect(assembler.push(chunk(16, 1))).toBe(true);
    expect(assembler.complete).toBe(false);
    expect(assembler.push(chunk(14, 2))).toBe(true);
    expect(assembler.complete).toBe(true);
    expect(assembler.received).toBe(30);

    const blob = assembler.blob();
    expect(blob.size).toBe(30);
    expect(blob.type).toBe('video/mp4');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(1);
    expect(bytes[29]).toBe(2);
  });

  it('refuses a stream that runs past what the offer declared', () => {
    // The quota was checked against the size in the offer. A stream allowed to
    // exceed it is a quota check that means nothing.
    const assembler = createAssembler({ size: 10, mime: '' });
    expect(assembler.push(chunk(8, 1))).toBe(true);
    expect(assembler.push(chunk(8, 1))).toBe(false);
    expect(assembler.received).toBe(8);
  });

  it('takes a Uint8Array view as readily as a buffer, and copies it', async () => {
    const backing = new Uint8Array([9, 9, 9, 9]);
    const assembler = createAssembler({ size: 4, mime: '' });
    assembler.push(backing);
    // The caller is allowed to reuse the buffer the moment `push` returns.
    backing.fill(0);
    expect(new Uint8Array(await assembler.blob().arrayBuffer())).toEqual(
      new Uint8Array([9, 9, 9, 9]),
    );
  });
});

describe('which ingest path a file takes', () => {
  it('believes the MIME type first and the extension second', () => {
    expect(isPictureFile('a.mp4', 'image/png')).toBe(true);
    expect(isPictureFile('a.png', 'video/mp4')).toBe(false);
    // A file picked out of a document provider frequently arrives typeless.
    expect(isPictureFile('holiday.JPG', '')).toBe(true);
    expect(isPictureFile('holiday.mp4', '')).toBe(false);
    // Anything unrecognisable goes to the video path, which is the one with the
    // honest rejection messages.
    expect(isPictureFile('mystery', '')).toBe(false);
  });
});
