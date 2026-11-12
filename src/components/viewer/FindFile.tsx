import { useId, useMemo, useState } from 'react';
import type { Commit, FileTrack } from '@/lib/schema';
import { formatDate } from '@/viewer/playback';

const LIMIT = 8;

type Match = { file: number; path: string; born: number };

/** Every path a file ever had counts, so a search finds files before they exist and after they go. */
export function findFiles(files: Pick<FileTrack, 'paths' | 'born'>[], query: string): Match[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Match[] = [];
  files.forEach((file, index) => {
    let path: string | null = null;
    for (const [, name] of file.paths) if (name.toLowerCase().includes(needle)) path = name;
    if (path) matches.push({ file: index, path, born: file.born });
  });
  return matches.sort((a, b) => a.born - b.born || a.path.localeCompare(b.path)).slice(0, LIMIT);
}

export function FindFile({
  files,
  commits,
  onClose,
  onSelect,
}: {
  files: Pick<FileTrack, 'paths' | 'born'>[];
  commits: Pick<Commit, 'time'>[];
  onClose: () => void;
  onSelect: (file: number) => void;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => findFiles(files, query), [files, query]);
  const id = useId();
  return (
    <div
      className="find"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="field">
        <label htmlFor={id}>find</label>
        <input
          id={id}
          type="search"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="a path, such as src/index"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
      {query.trim() && (
        <p className="form-note" role="status">
          {matches.length === 0
            ? 'no file in this history matches.'
            : `${matches.length === LIMIT ? 'first ' : ''}${matches.length} ${matches.length === 1 ? 'match' : 'matches'}. choosing one jumps to its first commit.`}
        </p>
      )}
      {matches.length > 0 && (
        <ul className="find-results">
          {matches.map((match) => (
            <li key={match.file}>
              <button type="button" className="index-row" onClick={() => onSelect(match.file)}>
                <span className="tone-faint">{formatDate(commits[match.born].time)}</span>
                <span className="tone-ink cased index-clip">{match.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
