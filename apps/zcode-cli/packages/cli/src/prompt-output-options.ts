// Modified by ZCode Feiyu.
import type { GlobalOptions } from "@zcode/shared-types";

export /**
 * Does this run print a JSON summary at the end?
 *
 * An explicit --output-format wins over the older --json flag, so that
 * `--output-format text` can turn the summary off again. Checking only
 * `options.json` here is a trap: `--output-format json` would parse fine and
 * then silently print plain text.
 */
const wantsJsonSummary = (options: GlobalOptions): boolean =>
  options.outputFormat === undefined
    ? options.json
    : options.outputFormat === "json" || options.outputFormat === "stream-json";

export /** Does this run write each session event as it happens? */
const wantsEventStream = (options: GlobalOptions): boolean =>
  options.outputFormat === "stream-json";
