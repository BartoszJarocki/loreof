# Design system: Lore

Lore uses the design system from [jarocki.me](https://jarocki.me). That site's `DESIGN.md` is the
source. This file records what I copied, how I wired it here, and what each page builds on.

## Overview

Every page should read like the index at the front of a notebook. Chrome is Geist Mono at 14px.
Chapter text and long prose switch to Geist at 16px. The only display type is the name `lore` in the
header, set in Geist Pixel Square.

One accent, `value`, marks a change, such as a file lit by a commit. Hierarchy comes from four text
tones on one background, from the switch between mono and sans, and from spacing. Buttons, rows, and
panels stay square. Nothing casts a shadow. The flare ring drawn over the map is a circle
(`border-radius: 50%` on `.map-ring`). The theme follows the reader's system setting. I didn't add a
toggle.

## Colors

The seven tokens are custom properties on `:root` in `src/app/globals.css`, redefined under
`@media (prefers-color-scheme: dark)`. No other stylesheet writes a literal color.
`tests/design-tokens.test.ts` fails when one does, or when a token loses its light or dark value.

| Token   | Light                   | Dark                   | Role                                                         |
| ------- | ----------------------- | ---------------------- | ------------------------------------------------------------ |
| `bg`    | `oklch(98.4% .0025 95)` | `oklch(15.5% .004 70)` | The page, and the text of an inverted row.                   |
| `ink`   | `oklch(21% .006 70)`    | `oklch(94% .004 80)`   | Names, titles, ledes, links, and the fill of a hovered row.  |
| `body`  | `oklch(40% .006 70)`    | `oklch(76% .004 80)`   | Prose and descriptions.                                      |
| `faint` | `oklch(54% .005 70)`    | `oklch(60% .004 80)`   | Dates, section labels, nav, trails, and input underlines.    |
| `rule`  | `oklch(91% .004 80)`    | `oklch(27% .004 70)`   | Hairlines. Never behind text.                                |
| `wash`  | `oklch(95.6% .004 85)`  | `oklch(20% .004 70)`   | A quiet surface, such as the empty map stage or a notice.    |
| `value` | `oklch(50% .1 60)`      | `oklch(80% .09 70)`    | A change: a file lit by the current commit. The only accent. |

Measured from computed styles in Chromium:

| Pair            | Light   | Dark    |
| --------------- | ------- | ------- |
| `ink` on `bg`   | 16.95:1 | 16.40:1 |
| `body` on `bg`  | 8.83:1  | 9.12:1  |
| `faint` on `bg` | 4.84:1  | 4.95:1  |

`faint` is the tone closest to 4.5:1. Don't lighten it in light mode or darken it in dark mode. The
map reads those tokens through a 1x1 canvas. WebGL can't parse `oklch`, so the canvas resolves them
to sRGB (`src/viewer/tokens.ts`). The `theme-color` values in `src/app/layout.tsx` copy `bg` as hex.

## Typography

| Face               | CSS variable                | Loaded in                                          |
| ------------------ | --------------------------- | -------------------------------------------------- |
| Geist Mono         | `--font-geist-mono`         | `src/app/layout.tsx`, every route                  |
| Geist Pixel Square | `--font-geist-pixel-square` | `src/app/layout.tsx`, every route                  |
| Geist              | `--font-geist-sans`         | `src/fonts/geist.ts`, imported where prose appears |

The files in `src/fonts` are jarocki.me's subsets, 77.8 kB together. Geist loads only where a page
imports `Geist` from `src/fonts/geist.ts` and sets `Geist.variable` on a wrapper. That's
`src/app/%5F/layout.tsx` for about, method, and privacy, and the viewer for chapter text. Elsewhere
a sans rule falls back to the system sans. Read `--font-geist-sans` in the rule that sets the font,
not in a custom property on `:root`. The variable only exists below the wrapper.

Type roles:

- **Name.** `.name`. Pixel Square 28px, line-height 1, `ink`. Once per page, in the header, linking
  home.
- **Chrome.** The body default. Geist Mono 14px/1.72. Nav, ledes, labels, rows, captions, controls.
- **Title.** `.title`. Geist 600, 30px/1.18, tracking `-0.028em`, at most 24ch, balanced.
- **Prose.** `.prose`. Geist 16px/1.75 in `body`, at most 37rem. Its `h2` is Geist 600 19px/1.4 in
  `ink`. Chapter text uses the same two roles.
- **Code.** Geist Mono, keeping its case.

### Case

The root sets `text-transform: lowercase`. Write copy in its natural case and let the root lower it.
Paths, SHAs, and code keep their case. `code`, `kbd`, `pre`, `samp`, and anything with `.cased` set
`text-transform: none`. Inputs show what the reader typed, and their placeholders are lowercase.
Text outside the page, such as titles and descriptions in metadata, is written in lowercase.

Chromium's `innerText` and accessibility tree return the lowercase text. A test that checks copy
reads `textContent`.

## Page layout

`src/app/layout.tsx` renders the shell for every route. A page doesn't render its own `main`.

- `.page` pads `clamp(48px, 11vh, 112px)` at the top, `clamp(20px, 9vw, 160px)` at the sides, and
  160px at the bottom. `.column` is 80ch, centered, text left-aligned. The root sets
  `scrollbar-gutter: stable`.
- The skip link comes first. It stays hidden until focused, then shows 12px above the column. It
  targets `main#main`, which takes focus without an outline.
- `SiteHeader` in `src/components/Shell.tsx` puts `lore` on the left and `collection method about`
  on the right in `faint`. The current page gets `aria-current="page"`, `ink`, and a 1px underline
  offset by 5px. `collection` links to `/#collection`, so the home page's collection section keeps
  that id.
- `SiteFooter` sits 72px below the page: `privacy`, `source ↗`, and `jarocki.me ↗` in `faint`.
- A lede, `Lede` or `.lede`, follows the header 40px below, in `ink`, at most 64ch.
- A section starts 56px below the block before it.

## The index row

`src/components/Index.tsx` exports the one shape every list uses. I ported it from jarocki.me.

- `IndexSection({ id?, label, more?, children })` renders a faint `h2` label and an optional
  right-aligned link, `→` or `↗` for `external`, with screen-reader context.
- `IndexList({ lead?, leadMobile?, children })` renders the `ul` and sets the lead column width
  through `--c1` and `--c1m`. The default is 10ch.
- `IndexRow({ href?, external?, lead, main, trail?, leadTone?, mainTone?, clip?, stackTrail? })`
  renders a Next `Link`, an `ExternalLink`, or a plain `div`. `lead` and `trail` default to `faint`
  and `main` to `ink`. A row led by a name passes `leadTone="ink"` and a `body` main.

Rules:

- The grid is `var(--c1) auto minmax(0, 1fr)` with a 3ch gap, so a long trail clips before `main`
  does.
- The row bleeds 1ch past the column on each side.
- A link row inverts on hover and `:focus-visible`: `ink` fill, every cell `bg`, no transition.
- At 640px and below the grid drops to two columns with a 2ch gap and hides the trail, unless the
  row passes `stackTrail`.
- `ExternalLink` opens a new tab and ends in a hidden ` (opens in new tab)`.

## Controls

- `.text-link` is `ink` text with a 1px `faint` underline offset by 0.28em, which turns `ink` on
  hover.
- `.faint-link` and `.text-button` are `faint` and turn `ink` on hover. A pressed `.text-button` is
  `ink` with a 1px underline offset by 5px. Buttons have no border and no fill.
- `.field` is one row: a `faint` prefix, the input on a 1px `faint` underline that turns `ink` on
  focus, and a text button. `.form-note` is a `faint` line under it.
- `:focus-visible` is a 1px `ink` outline offset by 3px everywhere. Link rows invert instead.
- `.plate` gives text a `bg` background 1ch wider on each side, for labels drawn over the map.

## Surfaces

Each surface keeps its own stylesheet, so the pages can be rebuilt in parallel.

| Stylesheet                  | Imported by                           | Covers                                          |
| --------------------------- | ------------------------------------- | ----------------------------------------------- |
| `src/app/globals.css`       | `src/app/layout.tsx`                  | Tokens, base type, shell, controls, index row.  |
| `src/app/home.css`          | `src/app/page.tsx`                    | The home page, gallery preview, form, waitlist. |
| `src/components/viewer.css` | `src/components/RepositoryViewer.tsx` | The repository page, its loader and errors.     |

`home.css` is interim. It puts the old home markup on the tokens and nothing more. The home rebuild
replaces it.

## The map

The repository page builds on `src/components/viewer/`: `Stage`, `ChapterCard`, `Timeline`,
`Chapter`, `Chapters`, and `FindFile`.

- The map clears to `bg` and bleeds to 120ch with no panel or border. Points are squares mixed from
  `bg` to `ink` by depth. A file touched in the last second of the tour is `value`.
  `src/viewer/tokens.ts` reads the tokens, and the stage reads them again when the scheme changes.
- Directory labels are Geist Mono 11px `faint` on `bg` plates, at most six, never overlapping. The
  hovered or found file gets a 1px `ink` square.
- The camera frames the 2nd to 98th percentile of the files alive at the cursor. On a portrait stage
  it rolls a quarter turn when that frames the map at least 10% larger, so the map's long side runs
  down the screen, and the turn eases. Labels stay horizontal. Points fade to `bg` over the 6px
  inside the stage edge, and a square the edge would cut isn't drawn.
- The current chapter row keeps its colors and underlines its title, 1px offset by 5px, like the
  current nav link. Hover and focus invert a row.
- Under the map, one caption row and one controls row. The timeline is monthly bars, `faint` up to
  the cursor and `rule` after it, over a 1px `faint` track with a 12px square `ink` thumb. A chapter
  starts after a 2px gap.
- The chapter text uses the title and prose roles. Short SHAs are Geist Mono 13px `faint`,
  underlined.
- `Chapter` takes a `ChapterView` from `src/viewer/story.ts`. That adapter turns an era into the
  chapter the panel renders. `src/lib/snapshot.ts` validates the narration fields, and
  `src/server/narration.ts` writes them.

## Motion

Hover changes color and nothing else. Links and text buttons fade from `faint` to `ink` over 150ms.
Rows invert at once. Under `prefers-reduced-motion: reduce`, every transition and animation is off.

## Accessibility

- Every text tone is at least 4.5:1 on `bg` in both schemes.
- One `main` per page, after the header, with a skip link to it.
- One `h1` per page. Pages without a visible title render it with `.sr-only`.
- Section labels are `h2` elements.
- Decorative arrows are `aria-hidden`.

## Do and don't

- Do build lists from `IndexSection`, `IndexList`, and `IndexRow`.
- Do pick colors from the seven tokens. An element that needs another color is probably too loud.
- Do keep Geist Mono for chrome and Geist for chapter text and prose.
- Do write copy in natural case and let the root lower it.
- Don't show uppercase anywhere a reader sees it, except paths, SHAs, and code.
- Don't add an accent beyond `value`, a gradient, or a shadow.
- Don't add a rounded corner. `.map-ring` is the circle that already exists.
- Don't add a theme toggle.
- Don't use Geist Pixel Square for anything but the name.
- Don't lower the contrast of `faint`.
