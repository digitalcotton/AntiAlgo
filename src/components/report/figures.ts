/**
 * Reading numbers back out of the fact strings, so a chart and the sentence
 * that cites it cannot drift apart.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * A chart is a number turned into a length. If the length is computed from a
 * literal typed into a component (`const arrivals = 41`) and the sentence under
 * it is quoted from src/data/facts.json, then there are two copies of one
 * statistic and nothing on earth keeps them equal. The first time somebody
 * restates a fact, the bar keeps the old shape and the caption tells the truth,
 * and the picture quietly becomes a lie that passes every gate.
 *
 * So every number a chart on /report draws is parsed out of the fact string it
 * is drawn beside. Restate the fact and the bar moves with it. Remove the number
 * from the string and this throws at build time rather than drawing a bar of
 * length zero and calling it a measurement.
 *
 * This is not a new idea here: `referenceDays()` in src/lib/data.ts already does
 * exactly this for the kill list's 9.8 day reference line, for the same reason.
 * These are the report's versions of the same discipline, kept in the report's
 * own directory because no other page draws these shapes.
 *
 * WHAT THIS FILE MAY NOT DO. It may not compute a new statistic. Reading "41"
 * out of "41% of applications arrive within 48 hours" is transcription. Working
 * out that the remaining share is 59 would be a new number with no source, and
 * it is exactly the thing BUILD.md calls a firing offense. Every function below
 * returns something the string already said.
 */

import { fact } from '../../lib/data';

/** The message every parse failure ends with, so all four read the same. */
function unreadable(id: string, wanted: string, source: string): Error {
  return new Error(
    `report/figures.ts: could not read ${wanted} out of the "${id}" fact ("${source}"). The chart draws that number, so it cannot be inferred, defaulted or typed in here. Either the fact was restated in a shape this parser does not know, or the chart is drawing something the fact never said.`
  );
}

/**
 * Every percentage in a fact string, in the order it appears.
 *
 * "41% of applications arrive within 48 hours, 56% within 96" gives [41, 56],
 * which is the cumulative arrival distribution, in order, with no interpolation
 * between the two and no tail invented after the second.
 */
export function percentagesIn(id: string): number[] {
  const source = fact(id);
  const found = [...source.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  if (found.length === 0) throw unreadable(id, 'a percentage', source);
  return found;
}

/**
 * Every hour count in a fact string, in the order it appears.
 *
 * The arrival fact carries two windows and only names the unit once ("within 48
 * hours, 56% within 96"), so the second number is matched on its own. That is a
 * property of how the fact is written, and the fallback is deliberately narrow:
 * a bare integer is only read as an hour count when the string already
 * established hours.
 */
export function hoursIn(id: string): number[] {
  const source = fact(id);
  if (!/\bhours?\b/.test(source)) throw unreadable(id, 'an hour count', source);
  const explicit = [...source.matchAll(/(\d+)\s*hours?\b/g)].map((match) => Number(match[1]));
  const trailing = [...source.matchAll(/within\s+(\d+)\b(?!\s*hours?)/g)].map((match) => Number(match[1]));
  const found = [...explicit, ...trailing].sort((a, b) => a - b);
  if (found.length === 0) throw unreadable(id, 'an hour count', source);
  return found;
}

/**
 * There was a ratio reader here, and its removal is part of a decision rather
 * than a tidy up.
 *
 * `ratioIn()` turned "Industry ghost rate runs about 1 in 5" into a position on
 * an axis so the report's trend chart could draw a reference line at it. Two
 * things happened on 2026-08-19 and either one alone would have retired it. The
 * Greenhouse citation was corrected to what it actually measures, "18 to 22% of
 * postings show no hiring activity in a given quarter", and a band is not a
 * line: drawing one would mean choosing a number inside the range, which is the
 * site inventing a statistic and attributing it to Greenhouse. And the column
 * that line was a reference FOR, our own ghost rate, came off the site entirely.
 *
 * Nothing on this site now renders a fact of the form "n in m". If one arrives,
 * this is in git.
 */

/**
 * The first plain count in a fact string.
 *
 * "The average job now draws about 254 applications" gives 254, which is the
 * hero number that fact is on the page to state. Percentages are skipped so a
 * fact carrying both cannot hand back the wrong one.
 */
export function countIn(id: string): number {
  const source = fact(id);
  const found = [...source.matchAll(/(\d[\d,]*(?:\.\d+)?)(\s*%)?/g)]
    .filter((match) => !match[2])
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
  if (found.length === 0) throw unreadable(id, 'a count', source);
  return found[0];
}
