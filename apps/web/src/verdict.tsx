import type { PostedReview, PrInfo, ReviewEvent } from '@docent/server';
import { useState } from 'react';
import { api } from './api.ts';

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
  posted,
  onPosted,
}: {
  pr: PrInfo;
  posted: PostedReview | null;
  onPosted: (posted: PostedReview) => void;
}) {
  const [event, setEvent] = useState<ReviewEvent | null>(null);
  const [summary, setSummary] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (posted) return <Posted pr={pr} posted={posted} />;

  const choice = event ? choiceFor(event) : null;
  const body = summary.trim();
  const needsSummary = event !== null && event !== 'APPROVE';
  const ready = choice !== null && (body !== '' || !needsSummary) && !sending;

  const send = async () => {
    if (!ready || !event) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.review.submit.$post({ json: { event, body } });
      const result = await res.json();
      if ('posted' in result) onPosted(result.posted);
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
            {body
              ? 'with this summary:'
              : needsSummary
                ? 'once you add a summary.'
                : 'with no summary.'}
          </p>
          {body && <blockquote className="verdict-quote">{body}</blockquote>}
        </div>
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
