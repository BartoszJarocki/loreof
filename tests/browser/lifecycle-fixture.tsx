import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { RepositoryViewer } from '../../src/components/RepositoryViewer';
import type { Manifest } from '../../src/lib/schema';
import { storyOf } from '../../src/lib/snapshot-pack';
import { snapshot } from './lifecycle-snapshot';

const manifest: Manifest = {
  ...snapshot,
  repository: { ...snapshot.repository, description: 'The React Framework \u202e123' },
  artifact: { pathname: 'fixture.json', sha256: '0'.repeat(64), bytes: 0 },
};
const container = document.getElementById('root');
if (!container) throw new Error('Missing fixture root.');
const root = createRoot(container);
root.render(
  <Profiler
    id="fixture"
    onRender={() => {
      window.lifecycle.commits++;
    }}
  >
    <RepositoryViewer story={storyOf(manifest)} timePin={null} />
  </Profiler>,
);
document.getElementById('unmount')?.addEventListener('click', () => root.unmount());
