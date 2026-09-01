import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LINK_RECEIPT, SAME_NETWORK_NOTE } from '../../../config/vocabulary';
import { formatBytes } from '../../../lib/bytes';
import { Button, Meter, Notice } from '../../../ui';
import { RECEIPT_LINGER_MS } from '../homeState';
import { submitVideoLink } from '../pasteLink';

import type { SendStatus, TransferSendHandle } from '../../../transfer/send';
import type { ConfigRuntime } from '../runtime';
import type { SyncHandle } from '../useSync';

/**
 * Adding something to the library, from a window that does not hold the bytes.
 *
 * ## The two doors, and why they are one control
 *
 * *"Paste a link"* has worked from the phone since wave 1 — the link is
 * committed as the source and the DISPLAY does the fetching, because CAM's two
 * browsers share a storage partition and a phone shares nothing with either.
 * *"Send a file"* is new, and it is the last genuinely device-local thing in the
 * product: a photo in a camera roll cannot reach the Kraken by any route the
 * app had, so it goes peer to peer over the LAN and lands in the same store,
 * through the same ingest pipeline, as a file dropped on CAM's own page.
 *
 * They sit behind ONE **Add** button because they are one intention. Two
 * separate controls would be the shape of the transport showing through the
 * shape of the shelf, which is the failure this whole arc is about.
 *
 * ## What it refuses to say
 *
 * Nothing here warns about networks up front. One STUN server, no TURN relay:
 * two peers on one home network connect on host candidates in well under a
 * second, and that is the overwhelming case. `SAME_NETWORK_NOTE` names the real
 * constraint, and it is rendered only when a transfer has genuinely failed or
 * timed out — a pre-emptive apology for a case that does not happen is how a
 * feature teaches its user not to trust it.
 */

const PCT = 100;

function pctOf(status: SendStatus): number | null {
  if (status.totalBytes <= 0) return null;
  return Math.min(PCT, (status.sentBytes / status.totalBytes) * PCT);
}

/**
 * A machine reason → the sentence a person reads.
 *
 * The reasons live in `src/transfer`, which the DISPLAY imports; the copy lives
 * here, which it must not. Two of them collapse to the same line on purpose:
 * "we never connected" and "we were connected and then were not" are the same
 * problem to somebody holding a phone, and it is nearly always the same cause.
 */
function failureLine(status: SendStatus): string {
  if (status.detail !== null) return status.detail;
  switch (status.refusal) {
    case 'unreachable':
    case 'interrupted':
      return SAME_NETWORK_NOTE;
    case 'quota':
      return 'There is not enough room in your library for that file.';
    case 'too-large':
      return 'That file is too large to send this way.';
    case 'busy':
      return 'Your Kraken is already receiving a file.';
    default:
      return 'That file could not be added.';
  }
}

export function RemoteAdd({ runtime, sync }: { runtime: ConfigRuntime; sync: SyncHandle }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [linkNote, setLinkNote] = useState<{ tone: 'error' | 'warn' | 'ok'; text: string } | null>(
    null,
  );
  const [status, setStatus] = useState<SendStatus | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const transfer = useRef<TransferSendHandle | null>(null);

  // A transfer outlives a render but not the page: a phone locked mid-send
  // leaves an `RTCPeerConnection` open on both ends otherwise.
  useEffect(
    () => () => {
      transfer.current?.cancel();
      transfer.current = null;
    },
    [],
  );

  const { sendCmd, subscribeTele } = sync;

  const send = useCallback(
    (file: File) => {
      transfer.current?.cancel();
      setLinkNote(null);
      void (async () => {
        const { startTransferSend } = await import('../../../transfer/send');
        transfer.current = startTransferSend({
          file,
          sendCmd: (op, arg) => {
            // `CmdOp` is the sync layer's vocabulary and `src/transfer` is
            // deliberately ignorant of it — the cast is the seam, and it is one
            // line rather than an import that would tie a leaf to the wire.
            sendCmd(op as Parameters<typeof sendCmd>[0], arg);
          },
          subscribeTele,
          onStatus: setStatus,
        });
      })();
    },
    [sendCmd, subscribeTele],
  );

  const addLink = (): void => {
    const outcome = submitVideoLink(runtime, draft);
    if (outcome.issue !== null) {
      setLinkNote({
        tone: outcome.issue.severity === 'error' ? 'error' : 'warn',
        text: outcome.issue.message,
      });
    } else {
      setLinkNote(null);
    }
    if (outcome.accepted) {
      setDraft('');
      setLinkNote({ tone: 'ok', text: LINK_RECEIPT });
    }
  };

  /**
   * The receipts here retire too — round 5's S4.
   *
   * *"Added to your library."* and `LINK_RECEIPT` are claims about a moment,
   * and both used to stand for the rest of the session: a phone left on a sofa
   * kept asserting a completed transfer for a file somebody had since deleted
   * in CAM. A failure is deliberately NOT retired — it names a remedy, and a
   * remedy that vanishes after four seconds is worse than none.
   */
  useEffect(() => {
    if (status?.phase !== 'done') return undefined;
    const timer = setTimeout(() => {
      setStatus(null);
    }, RECEIPT_LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  useEffect(() => {
    if (linkNote?.tone !== 'ok') return undefined;
    const timer = setTimeout(() => {
      setLinkNote(null);
    }, RECEIPT_LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [linkNote]);

  const busy =
    status !== null &&
    (status.phase === 'connecting' || status.phase === 'sending' || status.phase === 'storing');

  const line = useMemo(() => {
    if (status === null) return null;
    switch (status.phase) {
      case 'connecting':
        return 'Reaching your Kraken…';
      case 'sending':
        return `Sending — ${formatBytes(status.sentBytes)} of ${formatBytes(status.totalBytes)}`;
      case 'storing':
        return 'Your Kraken is keeping it…';
      case 'done':
        return 'Added to your library.';
      default:
        return failureLine(status);
    }
  }, [status]);

  return (
    <div className="kh-remoteadd" data-testid="remote-add-block">
      <div className="kh-remoteadd__head">
        <button
          type="button"
          className="kh-add"
          data-testid="remote-add"
          aria-expanded={open}
          aria-controls="kh-remote-add"
          title={open ? 'Close' : 'Add a link or a file'}
          onClick={() => {
            setOpen((was) => !was);
            setLinkNote(null);
          }}
        >
          <span aria-hidden="true">+</span>
          <span className="kh-add__lab">{open ? 'Close' : 'Add'}</span>
        </button>
      </div>

      {open && (
        <div className="kh-addpanel" id="kh-remote-add" data-testid="remote-add-panel">
          <form
            className="kh-addpanel__row"
            onSubmit={(e) => {
              e.preventDefault();
              addLink();
            }}
          >
            <input
              className="kh-input"
              id="remote-add-link"
              data-testid="remote-add-link"
              type="text"
              value={draft}
              aria-label="Paste a link"
              placeholder="Paste a link"
              onChange={(e) => {
                setDraft(e.target.value);
                setLinkNote(null);
              }}
            />
            <button
              type="submit"
              className="kh-btn kh-btn--primary"
              data-testid="remote-add-link-submit"
            >
              Add
            </button>
          </form>
          <div className="kh-addpanel__row">
            <Button
              testId="remote-send-file"
              title="Send a photo or a video from this device"
              disabled={busy}
              onClick={() => {
                fileInput.current?.click();
              }}
            >
              Send a file
            </Button>
          </div>
          {/*
            No `capture` attribute.

            `capture` forces the CAMERA and hides the camera roll, which is the
            opposite of what somebody who said "send a file" means. Leaving it
            off gives iOS and Android their own picker, which offers the roll,
            the camera and the files app together — the platform's answer, which
            is better than ours.
          */}
          <input
            ref={fileInput}
            data-testid="remote-file-input"
            type="file"
            accept="video/*,image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file !== undefined) send(file);
            }}
          />
          <p className="kh-hint">
            A link is fetched by your Kraken. A file is sent to it straight from this device.
          </p>
        </div>
      )}

      {linkNote !== null && <Notice tone={linkNote.tone}>{linkNote.text}</Notice>}

      {status !== null && (
        <div className="kh-transfer" data-testid="remote-transfer" data-phase={status.phase}>
          <p className="kh-hint" data-testid="remote-transfer-line">
            {line}
          </p>
          {status.phase === 'sending' && <Meter pct={pctOf(status)} />}
          {busy && (
            <Button
              testId="remote-transfer-cancel"
              title="Stop sending this file"
              onClick={() => {
                transfer.current?.cancel();
                transfer.current = null;
                setStatus(null);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
