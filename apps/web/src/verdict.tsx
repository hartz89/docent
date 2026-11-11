import { githubLineUrl } from '@docent/core';
import type { PostedReview, PrInfo, ReviewEvent, ReviewSnapshot } from '@docent/server';
import { useState } from 'react';
import { api } from './api.ts';
import { type Draft, landsOnDiff, whereLabel } from './comments.tsx';

type Diff = NonNullable<ReviewSnapshot['diff']>;

type Choice = { event: ReviewEvent; label: string; hint: string; action: string; done: string };

/** The three verdicts GitHub has, in GitHub's order. */
const CHOICES: readonly Choice[] = [
  {
    event: 'COMMENT',
    label: 'Comment',
    hint: 'Feedback, without a verdict',
    action: 'Comment on GitHub',
    done: 'Comment posted',
  },
  {
    event: 'APPROVE',
    label: 'Approve',
    hint: 'Ready to merge as it stands',
    action: 'Approve on GitHub',
    done: 'Approved',
  },
  {
    event: 'REQUEST_CHANGES',
    label: 'Request changes',
    hint: 'Needs work before it merges',
    action: 'Request changes on GitHub',
    done: 'Changes requested',
  },
];

const choiceFor = (event: ReviewEvent) => CHOICES.find((c) => c.event === event) as Choice;

/** What the top bar says once a review is posted. */
export const postedLabel = (posted: PostedReview) => choiceFor(posted.event).done;

/**
 * The verdict stop's form: choose a verdict, write a summary, see exactly what will be posted,
 * then post it with a deliberate click. Once posted, it shows the review and stays locked.
 */
export function VerdictForm({
  pr,
  diff,
  comments,
  stale,
  unsaved,
  posted,
  onPosted,
}: {
  pr: PrInfo;
  diff: Diff;
  /** The batch's comments, written at the head this tour covers. */
  comments: readonly Draft[];
  /** How many comments were written at an older head; they aren't sent. */
  stale: number;
  /** A comment is open with words not yet in the batch; sending now would leave them out. */
  unsaved: boolean;
  posted: PostedReview | null;
  onPosted: (posted: PostedReview, sent: readonly Draft[]) => void;
}) {
  const [event, setEvent] = useState<ReviewEvent | null>(null);
  const [summary, setSummary] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (posted) return <Posted pr={pr} posted={posted} />;

  const choice = event ? choiceFor(event) : null;
  const body = summary.trim();
  const needsSummary = event !== null && event !== 'APPROVE';
  const ready = choice !== null && (body !== '' || !needsSummary) && !sending && !unsaved;
  const onLines = comments.filter((c) => landsOnDiff(diff, c));
  const notes = comments.filter((c) => !landsOnDiff(diff, c));

  const send = async () => {
    if (!ready || !event) return;
    const sent = [...comments];
    setSending(true);
    setError(null);
    try {
      const res = await api.review.submit.$post({
        json: {
          event,
          body,
          comments: sent.map(({ path, side, line, body }) => ({ path, side, line, body })),
        },
      });
      const result = await res.json();
      if ('posted' in result) onPosted(result.posted, sent);
      else setError(result.error);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="verdict" aria-label="Your review">
      <fieldset className="verdict-choices" disabled={sending}>
        <legend className="verdict-label">Your review</legend>
        <p className="verdict-lede">
          Posts to GitHub as one review
          {comments.length > 0 ? `, with your ${plural(comments.length, 'comment')}.` : '.'}
        </p>
        {CHOICES.map((c) => (
          <label key={c.event} className={`verdict-choice ${c.event.toLowerCase()}`}>
            <input
              type="radio"
              name="verdict"
              value={c.event}
              checked={event === c.event}
              onChange={() => {
                setEvent(c.event);
                setError(null);
              }}
            />
            <span className="verdict-choice-label">{c.label}</span>
            <span className="verdict-choice-hint">{c.hint}</span>
          </label>
        ))}
      </fieldset>

      <label htmlFor="verdict-summary" className="verdict-label">
        Summary{' '}
        <span className="verdict-optional">
          {needsSummary ? '· needed' : event === 'APPROVE' ? '· optional' : ''}
        </span>
      </label>
      <textarea
        id="verdict-summary"
        value={summary}
        disabled={sending}
        placeholder={
          event === 'REQUEST_CHANGES'
            ? 'What should change before this merges?'
            : 'What you checked, and anything the author should know.'
        }
        onChange={(e) => {
          setSummary(e.target.value);
          setError(null);
        }}
      />

      {choice && (
        <div className="verdict-preview fade-in" aria-live="polite">
          <div className="verdict-preview-label">Will post to GitHub</div>
          <p>
            <strong>{choice.label}</strong> {pr.repo}#{pr.number} at{' '}
            <span className="mono">{pr.head.slice(0, 7)}</span> as you,{' '}
            {previewTail(onLines.length, body !== '' || notes.length > 0, needsSummary && !body)}
          </p>
          {onLines.length > 0 && (
            <ul className="verdict-lines" aria-label="Line comments">
              {onLines.map((c) => (
                <li key={c.id} className="verdict-line">
                  <span className="mono">{whereLabel(c)}</span> · {c.body}
                </li>
              ))}
            </ul>
          )}
          {(body || notes.length > 0) && (
            <div className="verdict-body">
              {body && <div className="verdict-summary">{body}</div>}
              {notes.map((note) => (
                <div key={note.id} className="verdict-note">
                  <a href={lineUrl(pr, note)} target="_blank" rel="noreferrer" className="mono">
                    {whereLabel(note)}
                  </a>
                  <blockquote>{note.body}</blockquote>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {unsaved && (
        <p className="verdict-stale" role="alert">
          You have a comment open that isn't in the batch yet. Add or cancel it before you send, so
          what posts is what you see.
        </p>
      )}

      {stale > 0 && (
        <p className="verdict-stale" role="note">
          {plural(stale, 'comment')} {stale === 1 ? 'was' : 'were'} written before the PR moved to{' '}
          <span className="mono">{pr.head.slice(0, 7)}</span>, so{' '}
          {stale === 1 ? "it isn't" : "they aren't"} sent. Keep or remove{' '}
          {stale === 1 ? 'it' : 'them'} in the list.
        </p>
      )}

      {error && (
        <p className="verdict-error" role="alert">
          {error}
        </p>
      )}

      <div className="verdict-actions">
        <span>Sent with your gh login, once.</span>
        <button type="button" className="primary-button" disabled={!ready} onClick={send}>
          {sending ? 'Posting…' : (choice?.action ?? 'Choose a verdict')}
        </button>
      </div>
    </section>
  );
}

/** The end of the preview's sentence: what the review carries besides the verdict. */
function previewTail(lineComments: number, hasBody: boolean, missingSummary: boolean): string {
  const lines = lineComments > 0 ? `with ${plural(lineComments, 'line comment')}` : '';
  if (missingSummary)
    return lines ? `${lines}, once you add a summary.` : 'once you add a summary.';
  if (hasBody) return lines ? `${lines} and this summary:` : 'with this summary:';
  return lines ? `${lines} and no summary.` : 'with no summary.';
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A line on GitHub, at the commit the comment is about: head, or base for a base line. */
const lineUrl = (pr: PrInfo, d: Draft) =>
  githubLineUrl(pr.repo, d.side === 'new' ? pr.head : pr.base, d.path, d.line);

function Posted({ pr, posted }: { pr: PrInfo; posted: PostedReview }) {
  return (
    <section
      className={`verdict posted ${posted.event.toLowerCase()} fade-in`}
      aria-label="Your review"
    >
      <div className="verdict-posted-head">
        <span className="verdict-posted-mark" aria-hidden="true">
          ✓
        </span>
        <div>
          <h3 className="verdict-posted-title">{postedLabel(posted)} on GitHub</h3>
          <p className="verdict-posted-meta">
            {pr.repo}#{pr.number} at <span className="mono">{posted.commitId.slice(0, 7)}</span>
            {posted.comments > 0 && `, with ${plural(posted.comments, 'comment')}`}
          </p>
        </div>
      </div>
      {posted.body && <blockquote className="verdict-quote">{posted.body}</blockquote>}
      <a className="verdict-link" href={posted.url} target="_blank" rel="noreferrer">
        View your review on GitHub <span aria-hidden="true">↗</span>
      </a>
    </section>
  );
}
