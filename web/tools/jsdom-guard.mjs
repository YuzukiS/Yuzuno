// The first import of every test that loads jsdom (T-29): it is evaluated
// before jsdom or any bundle is, and ends the process unless that memory is
// bounded (jsdom-limits.mjs says when). There is no switch to skip it.
import { cgroupLimits, verdict } from "./jsdom-limits.mjs";

const result = verdict({
  platform: process.platform,
  env: process.env,
  limits: process.platform === "linux" ? cgroupLimits() : null,
});
if (!result.ok) {
  process.stderr.write(`jsdom tests refused: ${result.why}\n`);
  process.exit(2);
}
