// Shared logger. Everything the background does goes through here so the
// noise is easy to spot (and easy to filter on) in the event page console.
//
// This module exists partly to prove ES modules work in a Firefox MV3 event
// page, which the multi-file background depends on (DESIGN.md §2).

const PREFIX = "%c[selfcontrol]";
const STYLE = "color:#e4572e;font-weight:bold";

export function log(...args) {
  console.log(PREFIX, STYLE, ...args);
}

export function warn(...args) {
  console.warn(PREFIX, STYLE, ...args);
}
