// A child-process renderer, used by the determinism pin in `render.test.ts`.
//
// It exists so the payload region can be rendered in a DIFFERENT PROCESS, under a
// different `TZ`, a different locale and a different clock, and the bytes compared. That
// is a real independent variable — which is what makes the pin a genuine comparison rather
// than the self-comparison a previous design shipped three times (same function, same
// immutable input, same instant: nothing could ever differ).
//
// It prints the payload region and NOTHING else, so a trailing newline or a log line
// cannot be mistaken for a difference in the thing under test.
import { renderPayloadRegion } from "../../src/render.js";

const payload = JSON.parse(process.argv[2] ?? "{}") as Record<string, unknown>;
const actionType = process.argv[3] ?? "send_email";
process.stdout.write(renderPayloadRegion(actionType, payload));
