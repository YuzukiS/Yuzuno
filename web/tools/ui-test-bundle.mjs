// JSDOM's outside-only harness evaluates classic scripts. Flatten the *built*
// module graph for interaction regressions; actual chunk loading is tested in
// Chromium. Rolldown is already part of this project's Vite toolchain.
import { rolldown } from "rolldown";
import { fileURLToPath } from "node:url";

export async function uiTestBundle(entry) {
  const build = await rolldown({
    input: fileURLToPath(entry),
    transform: {
      define: { "import.meta": JSON.stringify({ url: entry.href }) },
    },
  });
  try {
    const { output } = await build.generate({
      format: "iife",
      name: "YuzunoTestBundle",
      codeSplitting: false,
    });
    // JSDOM has no layout engine. Give CodeMirror the same empty geometry
    // supplied by JSDOM's Elements; browser acceptance covers real layout.
    const geometry = `Range.prototype.getClientRects ||= () => [];
      Range.prototype.getBoundingClientRect ||= () => ({left:0,right:0,top:0,bottom:0,width:0,height:0});\n`;
    return geometry + output.find((file) => file.type === "chunk").code;
  } finally {
    await build.close();
  }
}
