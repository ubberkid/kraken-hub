import { beforeEach, describe, expect, it } from 'vitest';

import { readRaw, writeRaw } from '../../platform/storage';

import {
  REMEMBERED_ROOM_SUFFIX,
  forgetRoom,
  readRememberedRoom,
  rememberRoom,
} from './rememberedRoom';

describe('rememberedRoom', () => {
  beforeEach(() => {
    forgetRoom();
  });

  it('is null until something is remembered', () => {
    expect(readRememberedRoom()).toBeNull();
  });

  it('round-trips a room code', () => {
    rememberRoom('ABCD1234');
    expect(readRememberedRoom()).toBe('ABCD1234');
    expect(readRaw(REMEMBERED_ROOM_SUFFIX)).toBe('ABCD1234');
  });

  it('normalises on the way in, so a typed code and a scanned one agree', () => {
    rememberRoom('abcd1234');
    expect(readRememberedRoom()).toBe('ABCD1234');
  });

  it('refuses to remember something that is not a room code', () => {
    rememberRoom('nope');
    expect(readRememberedRoom()).toBeNull();
  });

  /**
   * Shared origin, user-visible storage: garbage means "not paired".
   *
   * Specifically NOT normalised on read. `normalizeRoomCode` is forgiving by
   * design — it folds `{"not":"a code"}` into the valid-shaped `N0TAC0DE` — and
   * accepting that would have the sync layer derive a real topic and key for a
   * room nobody is in, which reads to the user as a broken remote rather than as
   * an unpaired one.
   */
  it('reads a corrupted value as not paired rather than normalising it into a real room', () => {
    writeRaw(REMEMBERED_ROOM_SUFFIX, '{"not":"a code"}');
    expect(readRememberedRoom()).toBeNull();
  });

  it('forgets', () => {
    rememberRoom('ABCD1234');
    forgetRoom();
    expect(readRememberedRoom()).toBeNull();
    expect(readRaw(REMEMBERED_ROOM_SUFFIX)).toBeNull();
  });
});
