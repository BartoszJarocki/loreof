import type { Metadata } from 'next';
import { IndexList, IndexRow, IndexSection, Lede } from '@/components/Index';

export const metadata: Metadata = { title: 'method' };
export default function Method() {
  return (
    <>
      <h1 className="sr-only">Method</h1>
      <Lede>
        Lore reads a repository’s Git history and plays it back as a map of files. Every caption
        links the commits it comes from.
      </Lede>
      <IndexSection label="reading the map">
        <IndexList lead="12ch">
          <IndexRow
            lead="point"
            leadTone="ink"
            main="A file, from its first commit to its deletion."
            mainTone="body"
          />
          <IndexRow
            lead="neighbors"
            leadTone="ink"
            main="Files that share a directory or change together. Nearness is not a dependency."
            mainTone="body"
          />
          <IndexRow lead="flash" leadTone="ink" main="A commit touching a file." mainTone="body" />
          <IndexRow
            lead="chapter"
            leadTone="ink"
            main="A stretch of history where the work changed shape, with the commits behind it."
            mainTone="body"
          />
          <IndexRow
            lead="author"
            leadTone="ink"
            main="The name Git records for a commit. It is not proof of who wrote it."
            mainTone="body"
          />
        </IndexList>
      </IndexSection>
      <div className="prose page-prose">
        <h2>One history to follow</h2>
        <p>
          Lore follows the first-parent chain of the default branch, so changes appear as they enter
          the main line. Work on other branches shows up as the merge that brought it in. An exact
          rename keeps a file’s identity. A move that also edits the file can appear as a deletion
          and a creation.
        </p>
        <h2>The map has a budget</h2>
        <p>
          A large history can hold more files and commits than a browser can draw. Lore then lays
          out a selection of files and samples the commits it uses to place them. File lifetimes and
          the timeline still count every commit, and each film reports what it covers and whether it
          was sampled.
        </p>
      </div>
    </>
  );
}
