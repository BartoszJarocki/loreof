'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { parseRepository } from '@/lib/repository';

const errorSchema = z.object({ error: z.string() });
export async function responseData(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => {
    throw new Error('The service returned an unreadable response. Try again.');
  });
  if (!response.ok) {
    const parsed = errorSchema.safeParse(data);
    throw new Error(
      parsed.success ? parsed.data.error : 'The request could not be completed. Try again.',
    );
  }
  return data;
}

export function RepositoryForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [navigating, startNavigation] = useTransition();
  return (
    <form
      className="repository-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const input = new FormData(event.currentTarget).get('repository');
        try {
          const slug = parseRepository(typeof input === 'string' ? input : '');
          setError(null);
          startNavigation(() => router.push(`/${slug}`));
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }}
    >
      <label className="sr-only" htmlFor="repository">
        Public GitHub repository
      </label>
      <div className="field">
        <span aria-hidden="true">github.com/</span>
        <input
          id="repository"
          name="repository"
          placeholder="owner/name"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'repository-error' : undefined}
          onChange={() => setError(null)}
        />
        <button type="submit">
          {navigating ? 'Reading…' : 'Read'} <span aria-hidden="true">→</span>
        </button>
      </div>
      {error && (
        <p id="repository-error" className="form-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
