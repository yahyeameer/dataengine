/**
 * Prettier, configured to agree with the code that is already here.
 *
 * There was no config before, which is not the same as there being no style:
 * the codebase has a consistent one, and running Prettier with its defaults
 * against it rewrote whole files -- double quotes, an 80-column measure -- and
 * buried a three-line change in a two-hundred-line reformat. This file exists
 * so the tool and the repository stop disagreeing.
 *
 * Every value below was measured rather than picked. The method: copy
 * `apps/web/src`, format the copy at a candidate setting, and count the lines
 * that setting would rewrite. The winner is the setting that changes least,
 * because that is the one the code was already written to. The generated
 * types file is excluded, as it is in `.prettierignore` -- left in, its four
 * thousand lines swamp every other signal.
 *
 *   printWidth   80 -> 2548 lines changed   trailingComma  all  ->  588
 *                90 -> 1333                                es5  ->  752
 *               100 ->  588  <-- minimum                   none -> 1416
 *               110 -> 1079
 *               120 -> 1630                 arrowParens  always ->  588
 *                                                        avoid  ->  958
 *
 * The curve has a clear floor at 100 and climbs steeply on both sides of it,
 * which is what a real house style looks like from the outside. `singleQuote`
 * needed no sweep: 262 single-quoted imports against 4 double, and all four of
 * those are in files that arrived from a generator (`app/layout.tsx`,
 * `lib/utils.ts`). `bracketSameLine` (896) and `singleAttributePerLine` (1320)
 * were tried too and both made it worse, so they stay at their defaults and
 * are not restated below.
 *
 * What is left is Prettier's defaults plus two deliberate departures --
 * `printWidth` and `singleQuote`. That is the whole config, and it should stay
 * that way: an option nobody can point at a measurement for is an option that
 * will be argued about later.
 *
 * The one override is `singleQuote` in CSS, and it is here because the first
 * version of this file got it wrong. `singleQuote` was measured on the
 * TypeScript, where it is right by 262 to 4 -- but Prettier applies it to
 * stylesheets as well, and `globals.css` is double-quoted 13 times out of 13.
 * Left alone it rewrote `@import "tailwindcss"`, both font stacks and every
 * `content: ""`. Two languages, two conventions, both counted.
 *
 * Head to head on five files, formatting each one with this config and again
 * with Prettier's defaults, counting the lines each run rewrites:
 *
 *   components/product-story.tsx      0  vs   80
 *   components/auth-screen.tsx        4  vs   16
 *   components/app-shell.tsx          5  vs   57
 *   app/onboarding/page.tsx          16  vs   68
 *   app/app/audit/page.tsx           28  vs  182
 *
 * `product-story.tsx` comes back byte for byte. That is the property this
 * file is for.
 *
 * Adding this reformats nothing. `npm run format:check` reports 56 files and
 * about a thousand lines of drift across the whole repository -- ordinary
 * hand-wrapping that differs from Prettier's. Closing it in one sweep would
 * rewrite the blame on most of the application for no behaviour change, so it
 * stays open: format the files you touch, and the number comes down on its
 * own.
 *
 * @type {import("prettier").Config}
 */
const config = {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  tabWidth: 2,
  trailingComma: 'all',
  arrowParens: 'always',
  overrides: [
    {
      // Stylesheets quote the other way round here. See above.
      files: ['*.css'],
      options: { singleQuote: false },
    },
  ],
};

export default config;
