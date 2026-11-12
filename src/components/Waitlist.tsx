'use client';
import Link from 'next/link';
import { useState } from 'react';
import { responseData } from './RepositoryForm';

export function Waitlist() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  if (state === 'saved')
    return (
      <p className="waitlist tone-body" role="status">
        Saved. Lore writes once, when private repositories ship.
      </p>
    );
  return (
    <form
      className="waitlist"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setState('saving');
        setError('');
        try {
          await responseData(
            await fetch('/api/waitlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: data.get('email'), consent: true }),
            }),
          );
          setState('saved');
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Could not save your email.');
          setState('idle');
        }
      }}
    >
      <label htmlFor="email">
        Private repositories are next. Leave an email and Lore writes once when they ship.
      </label>
      <div className="field">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'email-error' : undefined}
          disabled={state === 'saving'}
        />
        <button disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Notify me'}
        </button>
      </div>
      <p className="form-note">
        Submitting agrees to one email when private repositories ship. Stored up to 180 days.{' '}
        <Link href="/_/privacy">Privacy</Link>.
      </p>
      {error && (
        <p id="email-error" className="form-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
