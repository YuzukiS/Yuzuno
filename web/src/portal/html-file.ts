/** Whether a file is one this preview shows working: a single .html or .htm
 * (Core checks the same, and its size and encoding, before keeping it). */
export const htmlFile = (path: string) => /\.html?$/i.test(path);
